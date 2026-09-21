import { v4 as uuid } from "uuid";
import type { FileSystemOperations } from "./filesystem-operations";
import type {
    Database,
    EngineState,
    StoredSnapshot
} from "../persistence/database";
import { allocatePortablePath, isInternalPath } from "../utils/portable-path";
import {
    mergeContent,
    fromStoredSnapshot,
    toStoredSnapshot
} from "../sync-operations/content";
import type { ServerConfig } from "../services/server-config";
import {
    applyLocalChange,
    unappliedChanges,
    type LocalChange
} from "../sync-operations/local-changes";
import {
    FileNotFoundError,
    LocalChangesDuringReconciliation
} from "../errors/errors";

export interface FileWrite {
    expected?: StoredSnapshot;
    replacement: StoredSnapshot;
}

/** Files and metadata are independent observations, not a filesystem transaction.
 * Interrupted applications are reconciled by the next ordinary scan. */
export class FileOperations {
    private physical?: EngineState;

    public constructor(
        public readonly fs: FileSystemOperations,
        private readonly database: Database,
        private readonly serverConfig: ServerConfig,
        private readonly filesApplied: (
            paths: readonly string[]
        ) => void = () => undefined,
        private readonly localChanges: {
            entries: () => readonly LocalChange[];
            flush: () => Promise<void>;
        } = { entries: () => [], flush: async () => undefined },
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
        const snapshot = await this.fs.readSnapshot(path);
        return snapshot && toStoredSnapshot(snapshot);
    }

    public async captureChange(
        change: LocalChange,
        previous: readonly LocalChange[]
    ): Promise<void> {
        const state = structuredClone(this.physical ?? this.database.state);
        if (!state.initialized) return;
        for (const pending of unappliedChanges(state, previous))
            applyLocalChange(state, pending, () => false);
        applyLocalChange(state, change, () => false);
    }

    public async apply(
        next: EngineState,
        writes: Partial<Record<string, FileWrite>> = {},
        validatePlan: () => void = () => undefined
    ): Promise<void> {
        await this.localChanges.flush();
        const changes = this.localChanges.entries().length;
        let applying = false;
        const guard = (): void => {
            // Once mutations begin, incorporate bound notifications between files
            // and commit the batch before the next scan reads fresh content.
            if (applying) return;
            validatePlan();
            if (this.localChanges.entries().length > changes)
                throw new LocalChangesDuringReconciliation();
        };
        const beginMutation = (): void => {
            guard();
            applying = true;
        };
        guard();
        const physical = structuredClone(this.database.state);
        physical.initialized = next.initialized;
        this.physical = physical;
        const paths = new Set<string>();
        try {
            for (const id of new Set([
                ...Object.keys(physical.local),
                ...Object.keys(next.local)
            ])) {
                await this.incorporateChanges(next, physical, guard);
                let from =
                    Object.hasOwn(physical.documents, id) &&
                    physical.documents[id].materialized
                        ? physical.local[id]
                        : undefined;
                let to = Object.hasOwn(next.local, id)
                    ? next.local[id]
                    : undefined;
                const write = writes[id];
                if (write === undefined && (from === undefined || from === to))
                    continue;
                if (from !== undefined) paths.add(from);
                const info =
                    from !== undefined ? await this.fs.stat(from) : undefined;
                guard();
                if (
                    from !== undefined &&
                    info?.kind === "file" &&
                    this.protectedFile(from, info.size)
                ) {
                    next.local[id] = from;
                    next.documents[id] = structuredClone(
                        physical.documents[id]
                    );
                    (next.excluded ??= {})[id] =
                        physical.fileManifest.entries[id] ?? null;
                    (next.protectedPaths ??= []).push(from);
                    continue;
                }
                if (from !== undefined && info?.kind !== "file") {
                    Reflect.deleteProperty(next.local, id);
                    continue;
                }
                if (to === undefined) {
                    if (from !== undefined) {
                        beginMutation();
                        await this.fs.deleteFile(from);
                        Reflect.deleteProperty(physical.local, id);
                        await this.removeEmptyParents(from);
                    }
                    continue;
                }
                // Move an occupant aside in the visible namespace. This breaks
                // cycles without hiding source files in a recovery directory.
                if (from !== to) {
                    try {
                        to = await this.clearDestination(
                            next,
                            physical,
                            id,
                            to,
                            guard,
                            beginMutation
                        );
                        await this.ensureParents(to);
                    } catch (error) {
                        to = await this.fallbackPath(next, id, to, error);
                        await this.ensureParents(to);
                    }
                    next.local[id] = to;
                    // Clearing the destination may itself have moved this source
                    // (for example, a file becoming its own parent directory).
                    from =
                        Object.hasOwn(physical.documents, id) &&
                        physical.documents[id].materialized
                            ? physical.local[id]
                            : undefined;
                    if (from !== undefined) {
                        guard();
                        // Bind notifications delivered from inside rename to the
                        // destination identity. A failed rename aborts this plan.
                        beginMutation();
                        physical.local[id] = to;
                        await this.fs.rename(from, to);
                        paths.add(to);
                        await this.removeEmptyParents(from);
                        from = to;
                    }
                }
                if (write !== undefined) {
                    const current =
                        from !== undefined
                            ? await this.snapshot(from)
                            : undefined;
                    guard();
                    // A detected deletion is a local edit, not an invitation to
                    // recreate a previously materialized document.
                    if (from !== undefined && !current) {
                        Reflect.deleteProperty(next.local, id);
                        continue;
                    }
                    const replacement =
                        current && write.expected
                            ? await mergeContent(
                                  to,
                                  write.expected,
                                  current,
                                  write.replacement,
                                  (await this.serverConfig.getConfig())
                                      .mergeableFileExtensions
                              )
                            : write.replacement;
                    guard();
                    if (current?.hash !== replacement.hash) {
                        beginMutation();
                        if (current) await this.fs.deleteFile(to);
                        guard();
                        physical.local[id] = to;
                        physical.documents[id] = {
                            ...next.documents[id],
                            materialized: true
                        };
                        await this.fs.write(
                            to,
                            fromStoredSnapshot(replacement)
                        );
                    }
                    next.documents[id].observedHash = replacement.hash;
                    paths.add(to);
                }
                next.documents[id].materialized = true;
                physical.local[id] = to;
                physical.documents[id] = structuredClone(next.documents[id]);
            }
            await this.incorporateChanges(next, physical, guard);
            guard();
            await this.database.commit(next);
        } finally {
            this.physical = undefined;
            this.filesApplied([...paths]);
        }
    }

    private async incorporateChanges(
        next: EngineState,
        physical: EngineState,
        guard: () => void
    ): Promise<void> {
        await this.localChanges.flush();
        guard();
        for (const change of unappliedChanges(
            next,
            this.localChanges.entries()
        )) {
            const ignored = (path: string): boolean =>
                isInternalPath(path) || this.protectedFile(path, 0);
            applyLocalChange(physical, change, ignored);
            applyLocalChange(next, change, ignored);
            physical.lastAppliedLocalChangeId = next.lastAppliedLocalChangeId =
                change.changeId;
        }
    }

    private async clearDestination(
        next: EngineState,
        physical: EngineState,
        id: string,
        path: string,
        guard: () => void,
        beginMutation: () => void
    ): Promise<string> {
        for (;;) {
            const obstruction = await this.obstruction(path);
            if (!obstruction) return path;
            guard();
            const info = await this.fs.stat(obstruction.path);
            if (
                obstruction.kind === "file" &&
                info &&
                next.protectedPaths?.includes(obstruction.path) !== true &&
                !this.protectedFile(obstruction.path, info.size)
            ) {
                await this.moveAside(
                    next,
                    physical,
                    obstruction.path,
                    false,
                    beginMutation
                );
            } else if (obstruction.kind === "directory") {
                const children = await this.fs.listFilesRecursively(
                    obstruction.path
                );
                let movable = true;
                for (const child of children) {
                    const occupant = Object.keys(physical.local).find(
                        (other) => physical.local[other] === child
                    );
                    const childInfo = await this.fs.stat(child);
                    if (
                        occupant === undefined ||
                        !Object.hasOwn(physical.documents, occupant) ||
                        !physical.documents[occupant].materialized ||
                        next.local[occupant] === child ||
                        next.protectedPaths?.includes(child) === true ||
                        childInfo === undefined ||
                        this.protectedFile(child, childInfo.size)
                    ) {
                        movable = false;
                        break;
                    }
                }
                if (movable) {
                    // Only evacuate tracked sources already scheduled to leave.
                    // Root-level temporary names also break directory/file cycles.
                    for (const child of children)
                        await this.moveAside(
                            next,
                            physical,
                            child,
                            true,
                            beginMutation
                        );
                    beginMutation();
                    await this.fs.delete(obstruction.path);
                } else path = await this.conflictPath(next, id, path);
            } else {
                path = await this.conflictPath(next, id, path);
            }
        }
    }

    private async moveAside(
        next: EngineState,
        physical: EngineState,
        path: string,
        toRoot: boolean,
        beginMutation: () => void
    ): Promise<void> {
        const occupant =
            Object.keys(physical.local).find(
                (other) =>
                    Object.hasOwn(physical.documents, other) &&
                    physical.documents[other].materialized &&
                    physical.local[other] === path
            ) ?? uuid();
        const displaced = await this.conflictPath(
            next,
            occupant,
            toRoot ? (path.split("/").at(-1) ?? path) : path
        );
        await this.ensureParents(displaced);
        beginMutation();
        physical.local[occupant] = displaced;
        await this.fs.rename(path, displaced);
        if (!Object.hasOwn(physical.documents, occupant)) {
            const snapshot = await this.snapshot(displaced);
            physical.documents[occupant] = {
                materialized: true,
                observedHash: snapshot?.hash
            };
            next.documents[occupant] = structuredClone(
                physical.documents[occupant]
            );
            next.local[occupant] = displaced;
        } else if (next.local[occupant] === path)
            next.local[occupant] = displaced;
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
    }

    private async conflictPath(
        next: EngineState,
        id: string,
        path: string
    ): Promise<string> {
        const occupied = { ...next.local };
        Reflect.deleteProperty(occupied, id);
        for (const [i, diskPath] of (
            await this.listFilesRecursively()
        ).entries())
            occupied[`disk-${i}`] = diskPath;
        return allocatePortablePath(path, id, occupied);
    }

    private async fallbackPath(
        next: EngineState,
        id: string,
        path: string,
        error: unknown
    ): Promise<string> {
        const code =
            typeof error === "object" && error !== null && "code" in error
                ? error.code
                : undefined;
        if (
            ![
                "ENAMETOOLONG",
                "EINVAL",
                "ENOTSUP",
                "EOPNOTSUPP",
                "EACCES",
                "EPERM"
            ].includes(String(code))
        )
            throw error;
        const extension =
            /\.[^.]*$/u.exec(path.split("/").at(-1) ?? "")?.[0] ?? "";
        return this.conflictPath(next, id, `Recovered ${id}${extension}`);
    }

    private async ensureParents(path: string): Promise<void> {
        const parent = path.split("/").slice(0, -1).join("/");
        if (parent) await this.fs.createDirectory(parent);
    }

    private async removeEmptyParents(path: string): Promise<void> {
        let parent = path.split("/").slice(0, -1).join("/");
        while (parent && !isInternalPath(parent)) {
            const info = await this.obstruction(parent);
            if (
                info?.kind !== "directory" ||
                (await this.fs.listFilesRecursively(parent)).length
            )
                break;
            try {
                await this.fs.delete(parent);
            } catch {
                break;
            }
            parent = parent.split("/").slice(0, -1).join("/");
        }
    }
}
