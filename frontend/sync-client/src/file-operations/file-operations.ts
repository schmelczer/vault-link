import { v4 as uuid } from "uuid";
import type {
    FileSnapshot,
    FileSystemOperations
} from "./filesystem-operations";
import type {
    ApplicationJournal,
    Database,
    EngineState,
    FileStep,
    StoredSnapshot
} from "../persistence/database";
import {
    allocatePortablePath,
    INTERNAL_DIRECTORY,
    isInternalPath
} from "../utils/portable-path";
import {
    mergeContent,
    fromStoredSnapshot,
    toStoredSnapshot
} from "../sync-operations/content";
import type { ServerConfig } from "../services/server-config";
import { FileNotFoundError } from "../errors/errors";
import {
    applyLocalChange,
    unappliedChanges,
    type LocalChange
} from "../sync-operations/local-changes";
import { resolvePaths } from "../sync-operations/file-manifest";

export interface FileWrite {
    expected?: StoredSnapshot;
    replacement: StoredSnapshot;
}

/** The persisted journal bridges the filesystem and the metadata store. Every
 * source is staged before any destination is installed. A phase is saved BEFORE
 * an ambiguous rename, so recovery never reapplies a content merge to its output.
 */
export class FileOperations {
    public constructor(
        public readonly fs: FileSystemOperations,
        private readonly database: Database,
        private readonly serverConfig: ServerConfig,
        private readonly filesApplied: (
            paths: readonly string[]
        ) => void = () => {},
        private readonly localChanges: {
            entries: () => readonly LocalChange[];
            flush: () => Promise<void>;
        } = { entries: () => [], flush: async () => {} },
        private readonly protectedFile: (
            path: string,
            size: number
        ) => boolean = () => false
    ) {}

    public async read(path: string): Promise<Uint8Array> {
        const snapshot = await this.fs.readSnapshot(path);
        if (!snapshot)
            throw new FileNotFoundError(`File not found: ${path}`, path);
        return snapshot.content;
    }

    public async listFilesRecursively(): Promise<string[]> {
        return (await this.fs.listFilesRecursively()).filter(
            (path) => !isInternalPath(path)
        );
    }

    public async snapshot(path: string): Promise<StoredSnapshot | undefined> {
        const value = await this.fs.readSnapshot(path);
        return value && toStoredSnapshot(value);
    }

    /** Project journal phases onto the physical namespace before binding an
     * editor notification. Content hashes must never choose a notified identity. */
    private async physicalState(
        journal = this.database.state.application
    ): Promise<EngineState> {
        const state = structuredClone(journal?.next ?? this.database.state);
        if (journal) {
            for (const step of journal.steps) {
                if (step.superseded) continue;
                const origin = step.replacement ? step.output : step.staged;
                const path =
                    step.phase === "installed"
                        ? step.to
                        : step.phase === "installing" &&
                            !(await this.fs.exists(origin))
                          ? step.to
                          : (await this.fs.exists(step.staged))
                            ? step.staged
                            : step.from;
                if (path) state.local[step.documentId] = path;
                else delete state.local[step.documentId];
            }
        }
        return state;
    }

    public async captureChange(
        change: LocalChange,
        previous: readonly LocalChange[]
    ): Promise<void> {
        const state = await this.physicalState();
        // No notifications may bind provisional identities before the initial
        // snapshot is available. Replay the whole ordered queue at bootstrap,
        // including moves/deletions after creates.
        if (!state.initialized) return;
        for (const pending of unappliedChanges(state, previous))
            applyLocalChange(state, pending, () => false);
        if (
            change.type === "update" &&
            !Object.values(state.local).includes(change.path)
        ) {
            // An editor may save to the logical path while its original is in
            // staging. Namespace creates/deletes still bind to physical paths.
            const step = this.database.state.application?.steps.find(
                (step) =>
                    step.from === change.path && step.phase !== "installed"
            );
            if (step && isInternalPath(state.local[step.documentId] ?? ""))
                state.local[step.documentId] = change.path;
        }
        applyLocalChange(state, change, () => false);
    }

    private async incorporateLocalChanges(
        journal: ApplicationJournal
    ): Promise<void> {
        await this.localChanges.flush();
        const changes = unappliedChanges(
            journal.next,
            this.localChanges.entries()
        );
        if (!changes.length) return;
        const physical = await this.physicalState(journal);
        for (const change of changes) {
            if (change.type === "update") {
                const info = await this.fs.stat(change.path);
                for (const id of Object.keys(change.identities ?? {})) {
                    // A save immediately before the rename has already moved
                    // to staging by the time its notification is incorporated.
                    const stagedPath = physical.local[id];
                    const saved =
                        info ??
                        (stagedPath && isInternalPath(stagedPath)
                            ? await this.fs.stat(stagedPath)
                            : undefined);
                    if (
                        saved?.kind === "file" &&
                        this.protectPath(
                            journal,
                            physical,
                            id,
                            change.path,
                            saved.size
                        )
                    )
                        journal.next.local[id] = change.path;
                }
                await this.incorporateContentSave(journal, physical, change);
                journal.next.excluded = physical.excluded;
                journal.next.lastAppliedLocalChangeId = change.changeId;
                continue;
            }
            const before = { ...physical.local };
            const path =
                change.type === "move" ? change.relativePath : change.path;
            const info = await this.fs.stat(path);
            if (info?.kind === "file" && this.protectedFile(path, info.size))
                journal.next.protectedPaths = [
                    ...new Set([...(journal.next.protectedPaths ?? []), path])
                ];
            applyLocalChange(
                physical,
                change,
                (path) =>
                    isInternalPath(path) ||
                    this.protectedFile(path, 0) ||
                    journal.next.protectedPaths?.includes(path) === true ||
                    Object.keys(journal.next.excluded ?? {}).some(
                        (id) => before[id] === path
                    )
            );
            for (const id of new Set([
                ...Object.keys(before),
                ...Object.keys(physical.local)
            ])) {
                if (before[id] === physical.local[id]) continue;
                if (physical.local[id] === undefined)
                    delete journal.next.local[id];
                else {
                    const path = physical.local[id];
                    journal.next.local[id] = path;
                    const info = await this.fs.stat(path);
                    this.protectPath(
                        journal,
                        physical,
                        id,
                        path,
                        info?.size ?? 0
                    );
                }
                journal.next.documents[id] ??= physical.documents[id];
            }
            journal.next.excluded = physical.excluded;
            journal.next.lastAppliedLocalChangeId = change.changeId;
        }
        journal.next.local = resolvePaths(
            journal.next.local,
            journal.next.fileManifest.entries,
            Object.keys(journal.next.excluded ?? {}),
            journal.next.protectedPaths
        );
        for (const step of journal.steps) {
            if (step.superseded) continue;
            // A notified move can exclude an input after this transaction was
            // planned. Preserve its bytes as well as its chosen physical path.
            if (journal.next.excluded?.[step.documentId] !== undefined) {
                const origin = step.replacement ? step.output : step.staged;
                if (
                    step.phase === "installing" &&
                    !(await this.fs.exists(origin))
                )
                    step.phase = "installed";
                if (step.replacement && step.phase !== "installed") {
                    // contentWrite advanced the proposed merge context before
                    // applying bytes. Cancelling that application must retain
                    // the last incorporated base so reenabling the file still
                    // reconciles the deferred remote head. An installed output,
                    // including one whose acknowledgement was lost, keeps its
                    // new base for subsequent local edits.
                    const previous =
                        this.database.state.documents[step.documentId];
                    Object.assign(
                        journal.next.documents[step.documentId],
                        structuredClone({
                            base: previous?.base,
                            bootstrap: previous?.bootstrap,
                            recoveryBase: previous?.recoveryBase
                        })
                    );
                }
                step.replacement = undefined;
            }
            if (step.phase === "installed") {
                step.to = physical.local[step.documentId];
                continue;
            }
            if (step.phase === "planned") {
                const staged = await this.fs.exists(step.staged);
                const from = physical.local[step.documentId];
                if (staged && from !== step.staged) {
                    // A notified move/delete and path reuse raced the source
                    // rename. Bind the staged object to the new occupant, then
                    // stage the original identity from its notified location.
                    const occupant = Object.keys(physical.local).find(
                        (id) => physical.local[id] === step.from
                    );
                    const originalStaged = step.staged;
                    step.staged = `${step.staged}-${uuid()}`;
                    if (occupant) {
                        journal.steps.push({
                            documentId: occupant,
                            from: step.from,
                            to: journal.next.local[occupant],
                            staged: originalStaged,
                            output: `${originalStaged}.output`,
                            phase: "staged"
                        });
                        physical.local[occupant] = originalStaged;
                    } else {
                        // Retain an ambiguous object without merging it into a
                        // different document. Cleanup archives this source.
                        journal.steps.push({
                            ...step,
                            staged: originalStaged,
                            to: undefined,
                            replacement: undefined,
                            phase: "installed",
                            superseded: true
                        });
                    }
                }
                if (
                    !staged ||
                    (from !== undefined && !isInternalPath(from)) ||
                    from === undefined
                ) {
                    if (step.from && !from) step.replacement = undefined;
                    step.from = from;
                }
            }
            step.to = journal.next.local[step.documentId];
        }
        for (const [id, from] of Object.entries(physical.local)) {
            const to = journal.next.local[id];
            if (
                from === to ||
                isInternalPath(from) ||
                journal.steps.some(
                    (step) =>
                        step.documentId === id && step.phase !== "installed"
                )
            )
                continue;
            const prefix = `${INTERNAL_DIRECTORY}/transactions/${journal.id}/${id}-${uuid()}`;
            journal.steps.push({
                documentId: id,
                from,
                to,
                expected: await this.snapshot(from),
                staged: `${prefix}.source`,
                output: `${prefix}.output`,
                phase: "planned"
            });
        }
        await this.persist(journal);
    }

    private protectPath(
        journal: ApplicationJournal,
        physical: EngineState,
        id: string,
        path: string,
        size: number
    ): boolean {
        if (
            !this.protectedFile(path, size) &&
            !journal.next.protectedPaths?.includes(path)
        )
            return false;
        physical.excluded ??= {};
        physical.excluded[id] ??=
            this.database.state.fileManifest.entries[id] ?? null;
        journal.next.protectedPaths = [
            ...new Set([...(journal.next.protectedPaths ?? []), path])
        ];
        return true;
    }

    private async incorporateContentSave(
        journal: ApplicationJournal,
        physical: EngineState,
        change: LocalChange & { type: "update" }
    ): Promise<void> {
        for (const id of Object.keys(change.identities ?? {})) {
            const step = journal.steps.find(
                (step) =>
                    step.documentId === id &&
                    step.phase !== "installed" &&
                    !step.superseded
            );
            if (
                !step ||
                !(await this.fs.exists(step.staged)) ||
                (await this.fs.stat(change.path))?.kind !== "file"
            )
                continue;
            const moved =
                step.phase === "installing" &&
                !(await this.fs.exists(
                    step.replacement ? step.output : step.staged
                ));
            if (moved && step.to === change.path) continue;
            // Stage the editor's save as a continuation of the SAME identity.
            // The previous source stays in the journal until durable cleanup.
            const prefix = `${INTERNAL_DIRECTORY}/transactions/${journal.id}/${id}-${uuid()}`;
            if (moved && step.to) {
                // Installation won the race with a save to the old editor path.
                // Stage its output before reinstalling this identity's merge.
                journal.steps.push({
                    documentId: id,
                    from: step.to,
                    staged: `${prefix}.previous`,
                    output: `${prefix}.unused`,
                    phase: "planned",
                    superseded: true
                });
            }
            journal.steps.push({
                documentId: id,
                from: change.path,
                to: step.to,
                expected: step.expected,
                replacement: step.replacement,
                staged: `${prefix}.source`,
                output: `${prefix}.output`,
                phase: "planned"
            });
            step.to = undefined;
            step.replacement = undefined;
            step.phase = "installed";
            step.superseded = true;
            physical.local[id] = change.path;
        }
    }

    private directory(path: string): string {
        return path.split("/").slice(0, -1).join("/");
    }

    private async writeOnce(
        path: string,
        snapshot: FileSnapshot
    ): Promise<void> {
        const existing = await this.fs.readSnapshot(path);
        if (existing) {
            const actual = await toStoredSnapshot(existing);
            const expected = await toStoredSnapshot(snapshot);
            if (actual.contentBase64 !== expected.contentBase64)
                throw new Error(`Recovery artifact changed: ${path}`);
            await this.fs.flushPaths([path]);
            return;
        }
        await this.ensureParents(path);
        await this.fs.write(path, snapshot);
    }

    private async writeJsonOnce(path: string, value: unknown): Promise<void> {
        await this.writeOnce(path, {
            content: new TextEncoder().encode(JSON.stringify(value))
        });
    }

    private async persist(journal: ApplicationJournal): Promise<void> {
        await this.database.commit({
            ...this.database.state,
            application: journal
        });
    }

    public async retainSnapshot(
        requestId: string,
        documentId: string,
        path: string | undefined,
        snapshot: StoredSnapshot
    ): Promise<void> {
        const prefix = `${INTERNAL_DIRECTORY}/requests/${requestId}`;
        await this.writeOnce(`${prefix}.content`, fromStoredSnapshot(snapshot));
        const metadata = await this.fs.readSnapshot(`${prefix}.json`);
        if (metadata) {
            const saved: unknown = JSON.parse(
                new TextDecoder().decode(metadata.content)
            );
            if (
                typeof saved !== "object" ||
                saved === null ||
                !("documentId" in saved) ||
                saved.documentId !== documentId ||
                !("hash" in saved) ||
                saved.hash !== snapshot.hash
            )
                throw new Error(`Recovery artifact changed: ${prefix}.json`);
            await this.fs.flushPaths([`${prefix}.json`]);
            return; // originalPath is a hint recorded once, not request identity.
        }
        await this.writeJsonOnce(`${prefix}.json`, {
            documentId,
            originalPath: path,
            hash: snapshot.hash
        });
    }

    public async apply(
        next: EngineState,
        writes: Record<string, FileWrite> = {},
        validatePlan: () => void = () => {}
    ): Promise<void> {
        if (this.database.state.application)
            throw new Error(
                "Recover the existing filesystem transaction first"
            );

        const id = uuid();
        const steps: FileStep[] = [];
        for (const documentId of new Set([
            ...Object.keys(this.database.state.local),
            ...Object.keys(next.local)
        ])) {
            const oldPath = this.database.state.local[documentId];
            const newPath = next.local[documentId];
            const materialized =
                this.database.state.documents[documentId]?.materialized;
            const from = materialized ? oldPath : undefined;
            const write = writes[documentId];
            if (!write && (from === undefined || from === newPath)) continue;
            const expected =
                write?.expected ??
                (from ? await this.snapshot(from) : undefined);
            // An external deletion is a local change, not permission to resurrect
            // the file using a stale network response.
            if (from && !expected && !write) {
                delete next.local[documentId];
                continue;
            }
            const prefix = `${INTERNAL_DIRECTORY}/transactions/${id}/${documentId}`;
            steps.push({
                documentId,
                from,
                to: newPath,
                expected,
                replacement: write?.replacement,
                staged: `${prefix}.source`,
                output: `${prefix}.output`,
                phase: "planned"
            });
        }
        validatePlan();
        if (steps.length === 0) {
            const changedPaths = this.changedPaths(
                this.database.state.local,
                next.local
            );
            await this.database.commit(next);
            this.filesApplied(changedPaths);
            return;
        }

        const journal = {
            id,
            next: structuredClone(next),
            steps,
            extensions: (await this.serverConfig.getConfig())
                .mergeableFileExtensions
        };
        validatePlan();
        await this.persist(journal);
        await this.recover();
    }

    public async recover(): Promise<void> {
        const saved = this.database.state.application;
        if (!saved) return;

        const journal = structuredClone(saved);
        await this.fs.createDirectory(
            `${INTERNAL_DIRECTORY}/transactions/${journal.id}`
        );

        for (;;) {
            await this.incorporateLocalChanges(journal);
            // Stage every pending source before installing anything, including
            // occupants discovered during an earlier installation attempt.
            await this.stageSources(journal);
            const step = journal.steps.find(
                (step) => step.phase !== "installed"
            );
            if (!step) break;
            await this.prepareContent(journal, step);
            await this.incorporateLocalChanges(journal);
            if (step.superseded && step.phase === "installed") continue;
            try {
                await this.install(journal, step);
            } catch (error) {
                const code =
                    typeof error === "object" &&
                    error !== null &&
                    "code" in error &&
                    typeof error.code === "string"
                        ? error.code
                        : undefined;
                if (
                    step.to === undefined ||
                    ![
                        "ENAMETOOLONG",
                        "EINVAL",
                        "ENOTSUP",
                        "EOPNOTSUPP",
                        "EACCES",
                        "EPERM"
                    ].includes(code ?? "")
                )
                    throw error;
                const origin = step.replacement ? step.output : step.staged;
                // A rename that took effect must be acknowledged at its original
                // destination. Never infer failure from a failed durability flush.
                if (
                    step.phase === "installing" &&
                    !(await this.fs.exists(origin))
                )
                    throw error;
                if (step.replanned === true) throw error;
                const extension =
                    /\.[^.]*$/u.exec(step.to.split("/").at(-1) ?? "")?.[0] ??
                    "";
                const wanted = `Recovered ${step.documentId}${extension}`;
                step.to = await this.conflictPath(
                    journal,
                    step.documentId,
                    wanted
                );
                step.replanned = true;
                journal.next.local[step.documentId] = step.to;
                // The payload has already been prepared; persist the new target
                // before retrying so crashes cannot reapply its content merge.
                step.phase = "prepared";
                await this.persist(journal);
            }
        }

        // Once every install intent is durable, the journal can be replayed
        // without its staged inputs. Remove transient bytes before committing
        // the next engine state so an interrupted cleanup is retried.
        await this.cleanup(journal);
        await this.database.commit(journal.next);
        this.filesApplied(
            [
                ...new Set(
                    journal.steps.flatMap((step) => [step.from, step.to])
                )
            ].filter((path): path is string => path !== undefined)
        );
    }

    private async stageSources(journal: ApplicationJournal): Promise<void> {
        for (;;) {
            await this.incorporateLocalChanges(journal);
            const step = journal.steps.find((step) => step.phase === "planned");
            if (!step) break;
            // An existing staging file proves the move completed before a crash.
            if (step.from && !(await this.fs.exists(step.staged))) {
                const { from } = step,
                    { staged } = step;
                const present = await this.fs.exists(from);
                await this.incorporateLocalChanges(journal);
                if (
                    step.from !== from ||
                    step.staged !== staged ||
                    step.phase !== "planned"
                )
                    continue;
                if (present) {
                    await this.fs.rename(from, staged);
                    await this.incorporateLocalChanges(journal);
                    if (
                        step.from !== from ||
                        step.staged !== staged ||
                        step.phase !== "planned"
                    )
                        continue;
                } else {
                    // Preserve an external deletion instead of resurrecting it.
                    delete journal.next.local[step.documentId];
                    step.to = undefined;
                    step.replacement = undefined;
                }
            }
            if (step.from) await this.fs.flushPaths([step.from, step.staged]);
            step.phase = "staged";
            await this.persist(journal);
        }
        // Directory cleanup is also retried if staging completed before a crash.
        for (const step of journal.steps)
            await this.removeEmptyParents(step.from);
    }

    private async prepareContent(
        journal: ApplicationJournal,
        step: FileStep
    ): Promise<void> {
        if (step.phase !== "staged") return;
        const source = await this.snapshot(step.staged);
        if (source) {
            if (step.replacement && step.expected)
                step.replacement = await mergeContent(
                    step.to ?? step.from ?? "",
                    step.expected,
                    source,
                    step.replacement,
                    journal.extensions
                );
            // The prepared replacement now includes this source's edits. A
            // later save must be merged relative to this source, or superseded
            // local text is reintroduced from the already merged replacement.
            step.expected = source;
        }
        // Save the merged result before writing it, so recovery never merges twice.
        step.phase = "prepared";
        await this.persist(journal);
    }

    private async install(
        journal: ApplicationJournal,
        step: FileStep
    ): Promise<void> {
        if (step.to) {
            const origin = step.replacement ? step.output : step.staged;
            const alreadyMoved =
                step.phase === "installing" && !(await this.fs.exists(origin));
            if (alreadyMoved) {
                if (!(await this.fs.exists(step.to))) {
                    // The installed file was externally deleted before
                    // recovery. Preserve that deletion instead of failing or
                    // resurrecting bytes from metadata.
                    delete journal.next.local[step.documentId];
                    step.to = undefined;
                    step.replacement = undefined;
                    step.phase = "installed";
                    await this.persist(journal);
                    return;
                }
                await this.fs.flushPaths([origin, step.to]);
            } else {
                if (step.replacement)
                    await this.writeOnce(
                        step.output,
                        fromStoredSnapshot(step.replacement)
                    );
                await this.incorporateLocalChanges(journal);
                if (step.superseded) return;
                if (!(await this.clearDestination(journal, step, step.to)))
                    return;
                await this.ensureParents(step.to);
                await this.incorporateLocalChanges(journal);
                if (step.superseded) return;
                // Persist intent first; the no-replace rename protects against
                // another writer taking the destination after we checked it.
                step.phase = "installing";
                await this.persist(journal);
                await this.fs.rename(origin, step.to);
                await this.incorporateLocalChanges(journal);
                if (step.superseded) return;
            }
            const document = journal.next.documents[step.documentId];
            if (document) {
                document.materialized = true;
                document.observedHash =
                    step.replacement?.hash ??
                    (await this.snapshot(step.to))?.hash;
            }
        }
        // Deletions and completed renames share this path whether their
        // acknowledgement was received or lost. Transient bytes are removed
        // only after every step reaches this phase.
        step.phase = "installed";
        await this.persist(journal);
    }

    private async clearDestination(
        journal: ApplicationJournal,
        step: FileStep,
        path: string
    ): Promise<boolean> {
        const obstruction = await this.obstruction(path);
        if (!obstruction) return true;
        if (obstruction.kind === "file") {
            const info = await this.fs.stat(obstruction.path);
            if (
                journal.next.protectedPaths?.includes(obstruction.path) ===
                    true ||
                (info !== undefined &&
                    this.protectedFile(obstruction.path, info.size))
            ) {
                (journal.next.protectedPaths ??= []).push(obstruction.path);
                step.to = await this.conflictPath(
                    journal,
                    step.documentId,
                    path
                );
                journal.next.local[step.documentId] = step.to;
                await this.persist(journal);
            } else await this.displace(journal, obstruction.path);
        } else if (
            (await this.fs.listFilesRecursively(obstruction.path)).length
        ) {
            // Preserve unmanaged descendants by changing the incoming file's name.
            step.to = await this.conflictPath(journal, step.documentId, path);
            journal.next.local[step.documentId] = step.to;
            await this.persist(journal);
        } else {
            // The adapter only removes empty directories, including on a race.
            await this.fs.delete(obstruction.path);
            return true;
        }
        // The journal now contains a new source or destination. Retry it through
        // the main loop so newly discovered sources are staged before installing.
        return false;
    }

    private async obstruction(
        path: string
    ): Promise<{ path: string; kind: "file" | "directory" } | undefined> {
        const parts = path.split("/");
        for (let i = 0; i < parts.length; i++) {
            const prefix = parts.slice(0, i + 1).join("/");
            const info = await this.fs.stat(prefix);
            if (info && (info.kind === "file" || i === parts.length - 1))
                return { path: prefix, kind: info.kind };
        }
        return undefined;
    }

    private async conflictPath(
        journal: ApplicationJournal,
        documentId: string,
        path: string
    ): Promise<string> {
        const occupied = { ...journal.next.local };
        delete occupied[documentId];
        for (const [index, diskPath] of (
            await this.listFilesRecursively()
        ).entries())
            occupied[`disk-${index}`] = diskPath;
        return allocatePortablePath(path, documentId, occupied);
    }

    private async displace(
        journal: ApplicationJournal,
        path: string
    ): Promise<void> {
        const unexpected = await this.snapshot(path);
        if (!unexpected)
            throw new Error(`Destination changed during recovery: ${path}`);
        const documentId = uuid();
        const to = await this.conflictPath(journal, documentId, path);
        const prefix = `${INTERNAL_DIRECTORY}/transactions/${journal.id}/${documentId}`;
        journal.steps.push({
            documentId,
            from: path,
            to,
            expected: unexpected,
            staged: `${prefix}.source`,
            output: `${prefix}.output`,
            phase: "planned"
        });
        journal.next.local[documentId] = to;
        journal.next.documents[documentId] = {
            materialized: true,
            observedHash: unexpected.hash
        };
        await this.persist(journal);
    }

    private async ensureParents(path: string): Promise<void> {
        const parent = this.directory(path);
        if (parent) await this.fs.createDirectory(parent);
    }

    private async removeEmptyParents(path?: string): Promise<void> {
        if (!path) return;
        let parent = this.directory(path);
        while (parent && !isInternalPath(parent)) {
            // An earlier installation may have turned an ancestor into a file.
            const info = await this.obstruction(parent);
            if (!info) {
                parent = this.directory(parent);
                continue;
            }
            if (info.kind !== "directory") break;
            if ((await this.fs.listFilesRecursively(parent)).length) break;
            // delete() must reject non-empty directories, including unmanaged entries.
            try {
                await this.fs.delete(parent);
            } catch {
                break;
            }
            parent = this.directory(parent);
        }
    }

    private async cleanup(journal: ApplicationJournal): Promise<void> {
        for (const step of journal.steps) {
            const source = await this.snapshot(step.staged);
            if (
                source &&
                (!step.to ||
                    (step.replacement && source.hash !== step.replacement.hash))
            ) {
                const prefix = `${INTERNAL_DIRECTORY}/recovery/${journal.id}-${step.staged.split("/").at(-1)}`;
                await this.writeOnce(
                    `${prefix}.content`,
                    fromStoredSnapshot(source)
                );
                await this.writeJsonOnce(`${prefix}.json`, {
                    documentId: step.documentId,
                    originalPath: step.from,
                    hash: source.hash
                });
            }
            for (const path of [
                step.staged,
                step.output,
                `${step.staged}.recovery`,
                `${step.staged}.json`
            ]) {
                if (await this.fs.exists(path)) await this.fs.deleteFile(path);
            }
        }
        const completed = `${INTERNAL_DIRECTORY}/transactions/${journal.id}/completed.json`;
        if (await this.fs.exists(completed))
            await this.fs.deleteFile(completed);
        await this.fs.delete(
            `${INTERNAL_DIRECTORY}/transactions/${journal.id}`
        );
    }

    private changedPaths(
        before: Readonly<Record<string, string>>,
        after: Readonly<Record<string, string>>
    ): string[] {
        const result = new Set<string>();
        for (const id of new Set([
            ...Object.keys(before),
            ...Object.keys(after)
        ])) {
            if (before[id] === after[id]) continue;
            if (before[id] !== undefined) result.add(before[id]);
            if (after[id] !== undefined) result.add(after[id]);
        }
        return [...result];
    }
}
