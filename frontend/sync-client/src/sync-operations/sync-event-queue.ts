import type { Settings } from "../persistence/settings";
import type { Logger } from "../tracing/logger";
import { globsToRegexes } from "../utils/globs-to-regexes";
import { isConflictPath } from "./conflict-path";
import { removeFromArray } from "../utils/remove-from-array";
import {
    SyncEventType,
    type DocumentId,
    type DocumentRecord,
    type FileSyncEvent,
    type RelativePath,
    type StoredSyncState,
    type SyncEvent,
    type VaultUpdateId,
} from "./types";
import { sleep } from "../utils/sleep";

export const SAVE_RETRY_BASE_DELAY_MS = 50;
export const SAVE_RETRY_MAX_ATTEMPTS = 3;

export class SyncEventQueue {
    // Latest state of the filesystem as we know it, excluding
    // unconfirmed creates but including pending deletes.
    //
    // It's always indexed by the latest path on disk.
    // 
    // It maps a subset of the remote state onto the local filesystem.
    private readonly documents = new Map<RelativePath, DocumentRecord>();

    // All outstanding operations in order of occurrence,
    // can include multiple generations of the same document, 
    // e.g.: a create, delete, create sequence for the same path.
    //
    // The paths within the events must always correspond to the latest
    // path on disk, so the path of each event may be updated multiple
    // times. 
    //
    // It maps pending changes onto the local filesystem.
    private readonly events: SyncEvent[] = [];

    // file creations for paths matching any of these patterns will be ignored
    private ignorePatterns: RegExp[];

    private savePending = false;


    private lastSeenUpdateId: VaultUpdateId;

    public constructor(
        private readonly settings: Settings,
        private readonly logger: Logger,
        initialState: Partial<StoredSyncState> | undefined,
        private readonly saveData: (data: StoredSyncState) => Promise<void>
    ) {
        this.ignorePatterns = globsToRegexes(
            this.settings.getSettings().ignorePatterns,
            this.logger
        );

        this.settings.onSettingsChanged.add((newSettings) => {
            this.ignorePatterns = globsToRegexes(
                newSettings.ignorePatterns,
                this.logger
            );
        });

        initialState ??= {};

        if (initialState.documents !== undefined) {
            for (const { relativePath, ...record } of initialState.documents) {
                this.documents.set(relativePath, record);
            }
        }
        this.lastSeenUpdateId = initialState.lastSeenUpdateId ?? -1;

        this.logger.debug(`Loaded ${this.documents.size} documents and lastSeenUpdateId=${this.lastSeenUpdateId} from storage`);
    }

    public get pendingUpdateCount(): number {
        return this.events.length;
    }

    public get syncedDocumentCount(): number {
        return this.documents.size;
    }

    // todo: let's remove
    public getSettledDocumentByPath(path: RelativePath): DocumentRecord | undefined {
        return this.documents.get(path);
    }

    public getDocumentByDocumentId(
        target: DocumentId
    ): { path: RelativePath; record: DocumentRecord } | undefined {
        for (const [path, record] of this.documents) {
            if (record.documentId === target) {
                return { path, record };
            }
        }
        return undefined;
    }

    public setDocument(path: RelativePath, record: DocumentRecord): void {
        this.documents.set(path, record);
        this.saveInTheBackground();
    }

    public removeDocument(path: RelativePath): void {
        this.documents.delete(path);
        this.saveInTheBackground();
    }

    /**
     * Reflect a local rename in the queue's disk-path index.
     *
     * Mirrors the `input.oldPath !== undefined` branch of `enqueue`, but
     * without emitting a new `SyncLocal` — used by `FileOperations.move`
     * when the rename is a byproduct of another sync operation (e.g. the
     * user dragging a file) and the caller will push the resulting event
     * separately, or not at all.
     *
     * If the rename targets a path that already holds a settled record
     * (e.g. concurrent clobber), the destination's record is dropped: the
     * caller is expected to have moved the displaced file out of the way
     * via `ensureClearPath` already, so the dropped record reflects the
     * now-orphaned disk state.
     */
    public moveDocument(
        oldPath: RelativePath,
        newPath: RelativePath
    ): void {
        if (oldPath === newPath) return;

        const record = this.documents.get(oldPath);
        if (record !== undefined) {
            // If `newPath` already holds a settled record, overwriting it
            // silently would orphan that document's identity. Warn so the
            // bug is visible; the caller is expected to have freed the
            // destination via `ensureClearPath` first.
            const clobbered = this.documents.get(newPath);
            if (clobbered !== undefined) {
                this.logger.warn(
                    `moveDocument(${oldPath} → ${newPath}) is overwriting a settled record for document ${clobbered.documentId}; caller should have displaced it first`
                );
            }

            this.documents.delete(oldPath);
            this.documents.set(newPath, record);
            for (const e of this.events) {
                if (
                    e.type === SyncEventType.LocalUpdate &&
                    e.documentId === record.documentId
                ) {
                    e.path = newPath;
                }
            }
            this.saveInTheBackground();
            return;
        }

        // No settled record — the rename may be over a pending Create
        // whose document hasn't been persisted on the server yet.
        this.updatePendingCreatePath(oldPath, newPath);
    }

    /**
     * Call once a create has been acknowledged by the server.
     */
    public resolveCreate(
        event: Extract<SyncEvent, { type: SyncEventType.LocalCreate }>,
        record: DocumentRecord
    ): void {
        const promise = event.resolvers?.promise;

        this.documents.set(event.path, record);
        event.resolvers?.resolve(record.documentId);

        if (promise !== undefined) {
            for (const e of this.events) {
                if (
                    (e.type === SyncEventType.LocalUpdate || e.type === SyncEventType.LocalDelete) &&
                    e.documentId === promise
                ) {
                    (e as { documentId: DocumentId | Promise<DocumentId> }).documentId = record.documentId;
                }
            }
        }

        this.saveInTheBackground();
    }

    public getCreatePromise(path: RelativePath): Promise<DocumentId> | undefined {
        const event = this.findLastCreate(path);
        if (event === undefined) return undefined;
        event.resolvers ??= Promise.withResolvers<DocumentId>();
        return event.resolvers.promise;
    }

    public allSettledDocuments(): [RelativePath, DocumentRecord][] {
        return Array.from(this.documents.entries());
    }

    /**
     * Returns the set of paths we expect to exist on disk by replaying
     * the event queue on top of the settled documents map.
     */
    public trackedPaths(): Set<RelativePath> {
        const paths = new Set(this.documents.keys());
        // Track current path for each pending create so moves can be applied
        const pendingPaths = new Map<Promise<DocumentId>, RelativePath>();

        for (const event of this.events) {
            if (event.type === SyncEventType.LocalCreate) {
                paths.add(event.path);
                if (event.resolvers !== undefined) {
                    pendingPaths.set(event.resolvers.promise, event.path);
                }
            } else if (event.type === SyncEventType.LocalDelete) {
                if (typeof event.documentId === "string") {
                    const path = this.getDocumentByDocumentId(event.documentId)?.path;
                    if (path) {
                        paths.delete(path);
                    } else {
                        throw new Error(`Delete event for unknown documentId ${event.documentId}`);
                    }
                } else {
                    const path = pendingPaths.get(event.documentId);
                    if (!path) {
                        throw new Error(`Delete event with unresolved documentId promise`);
                    }
                    paths.delete(path);
                }
            } // no need to handle SyncLocal as path updates are applied to this.documents immediately when the event is enqueued
        }
        return paths;
    }

    public hasPendingEventsForPath(path: RelativePath): boolean {
        const record = this.documents.get(path);
        if (!record) {
            return true; // if we don't know about this path, it must be pending creation
        }
        const docId = record.documentId;
        return this.events.some(
            (e) =>
                (e.type === SyncEventType.LocalCreate && e.path === path) ||
                (e.type === SyncEventType.LocalUpdate &&
                    e.documentId === docId) ||
                (e.type === SyncEventType.LocalDelete &&
                    e.documentId === docId) ||
                (e.type === SyncEventType.RemoteUpdate &&
                    // we care about the local path not the remote
                    this.getDocumentByDocumentId(e.remoteVersion.documentId)?.path === path) ||
                (e.type === SyncEventType.RemotePathChange &&
                    this.getDocumentByDocumentId(e.pathChange.documentId)?.path === path)
        );
    }

    public async save(): Promise<void> {
        return this.saveData({
            documents: Array.from(this.documents.entries()).map(
                ([relativePath, record]) => ({
                    relativePath,
                    ...record
                })
            ),
            lastSeenUpdateId: this.lastSeenUpdateId
        });
    }

    public resetState(): void {
        this.rejectAllPendingCreates();
        this.documents.clear();
        this.saveInTheBackground();
    }

    public clear(): void {
        this.rejectAllPendingCreates();
        this.events.length = 0;
    }

    public enqueue(input: FileSyncEvent): void {
        if (
            input.type === SyncEventType.RemoteUpdate ||
            input.type === SyncEventType.RemotePathChange
        ) {
            this.events.push(input);
            return;
        }

        const { path } = input;

        // Conflict-displaced files are local-only bookkeeping so a conflict
        // hit is a debug-level event. A hit against a user-configured glob
        // is a higher-signal "we're deliberately not syncing this" and
        // stays at info.
        if (isConflictPath(path)) {
            this.logger.debug(
                `Ignoring ${input.type} for ${path}: conflict-displaced file`
            );
            return;
        }
        if (this.matchesUserIgnorePattern(path)) {
            this.logger.info(
                `Ignoring ${input.type} for ${path} as it matches ignore patterns`
            );
            return;
        }

        if (input.type === SyncEventType.LocalCreate) {
            this.events.push({ type: SyncEventType.LocalCreate, path, originalPath: path });
            return;
        }

        const lookupPath = (input.type === SyncEventType.LocalUpdate && input.oldPath) ? input.oldPath : path;
        const record = this.documents.get(lookupPath);
        const documentId: DocumentId | Promise<DocumentId> | undefined =
            record?.documentId ?? this.getCreatePromise(lookupPath);
        if (documentId === undefined) return;

        if (input.type === SyncEventType.LocalDelete) {
            this.events.push({ type: SyncEventType.LocalDelete, documentId });
            return;
        }

        if (input.oldPath !== undefined) {
            if (typeof documentId === "string") {
                this.documents.delete(input.oldPath);
                this.documents.set(path, record!);
                for (const e of this.events) {
                    if (e.type === SyncEventType.LocalUpdate && e.documentId === documentId) {
                        e.path = path;
                    }
                }
                this.saveInTheBackground();
            } else {
                this.updatePendingCreatePath(input.oldPath, path);
            }
        }
        this.events.push({ type: SyncEventType.LocalUpdate, documentId, path, originalPath: path });
    }



    public async next(): Promise<SyncEvent | undefined> {
        if (this.events.length === 0) return undefined;

        const [first] = this.events;

        // Creates are always returned immediately (FIFO)
        if (first.type === SyncEventType.LocalCreate) {
            this.events.shift();
            return first;
        }

        // Deletes are returned immediately; also discard any subsequent
        // events for the same documentId so stale broadcasts don't
        // resurrect the document. If the documentId is still a pending
        // `Promise<DocumentId>` (the originating Create hasn't landed
        // yet), awaiting it may reject — handle that: the Create was
        // cancelled, so the Delete has nothing to delete, just drop it.
        if (first.type === SyncEventType.LocalDelete) {
            this.events.shift();
            const { documentId } = first;
            let resolvedId: DocumentId;
            try {
                resolvedId = await documentId;
            } catch {
                this.logger.debug(
                    "Dropping Delete whose Create was cancelled before it could be synced"
                );
                return this.next();
            }
            this.removeAllEventsForDocumentId(resolvedId);
            return first;
        }

        if (first.type === SyncEventType.LocalUpdate) {
            const { documentId } = first;

            // If there's a later delete for the same documentId, discard
            // all sync-locals for that document and return the delete
            const deleteEvent = this.events.find(
                (e) =>
                    e.type === SyncEventType.LocalDelete &&
                    e.documentId === documentId
            );
            if (deleteEvent !== undefined) {
                let resolvedId: DocumentId;
                try {
                    resolvedId = await documentId;
                } catch {
                    this.logger.debug(
                        "Dropping SyncLocal+Delete whose Create was cancelled before it could be synced"
                    );
                    return this.next();
                }
                this.removeAllEventsForDocumentId(resolvedId);
                return deleteEvent;
            }

            // Coalesce multiple sync-locals for the same documentId and
            // original path to the last one
            const matching = this.events.filter(
                (e) =>
                    e.type === SyncEventType.LocalUpdate &&
                    e.documentId === documentId &&
                    e.originalPath === first.originalPath // can't coalesce moves as they can depend on each other so we have to sync them in the same order, could do topological sort but let's keep it simple for now
            );
            const result = matching[matching.length - 1];
            for (const item of matching) {
                removeFromArray(this.events, item);
            }
            return result;
        }

        // Coalesce multiple events of the same remote kind for the same
        // documentId to the last one. Kinds are coalesced independently so
        // that an interleaved content+path stream (e.g. VaultUpdate →
        // PathChange) still preserves the VaultUpdate-before-PathChange
        // ordering invariant the syncer relies on.
        if (first.type === SyncEventType.RemoteUpdate) {
            const { documentId } = first.remoteVersion;
            const matching = this.events.filter(
                (e) =>
                    e.type === SyncEventType.RemoteUpdate &&
                    e.remoteVersion.documentId === documentId
            );
            const result = matching[matching.length - 1];
            for (const item of matching) {
                removeFromArray(this.events, item);
            }
            return result;
        }

        // SyncRemotePath
        const { documentId } = first.pathChange;
        const matching = this.events.filter(
            (e) =>
                e.type === SyncEventType.RemotePathChange &&
                e.pathChange.documentId === documentId
        );
        const result = matching[matching.length - 1];
        for (const item of matching) {
            removeFromArray(this.events, item);
        }
        return result;
    }

    private matchesUserIgnorePattern(path: RelativePath): boolean {
        return this.ignorePatterns.some((pattern) => pattern.test(path));
    }

    private isIgnored(path: RelativePath): boolean {
        return isConflictPath(path) || this.matchesUserIgnorePattern(path);
    }

    public removeAllEventsForDocumentId(documentId: DocumentId): void {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (
                (e.type === SyncEventType.LocalUpdate &&
                    e.documentId === documentId) ||
                (e.type === SyncEventType.RemoteUpdate &&
                    e.remoteVersion.documentId === documentId) ||
                (e.type === SyncEventType.RemotePathChange &&
                    e.pathChange.documentId === documentId) ||
                (e.type === SyncEventType.LocalDelete &&
                    e.documentId === documentId)
            ) {
                // eslint-disable-next-line no-restricted-syntax -- Bulk removal by predicate, not single-item removal
                this.events.splice(i, 1);
            }
        }
    }

    public updatePendingCreatePath(
        oldPath: RelativePath,
        newPath: RelativePath
    ): void {
        const createEvent = this.findLastCreate(oldPath);
        if (createEvent === undefined) return;

        const promise = createEvent.resolvers?.promise;
        createEvent.path = newPath;

        if (promise !== undefined) {
            for (const e of this.events) {
                if (
                    e.type === SyncEventType.LocalUpdate &&
                    e.documentId === promise
                ) {
                    e.path = newPath;
                }
            }
        }
    }

    private findCreatePathByPromise(
        promise: Promise<DocumentId>
    ): RelativePath | undefined {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (
                e.type === SyncEventType.LocalCreate &&
                e.resolvers?.promise === promise
            ) {
                return e.path;
            }
        }
        return undefined;
    }

    private findLastCreate(
        path: RelativePath
    ): Extract<SyncEvent, { type: SyncEventType.LocalCreate }> | undefined {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (e.type === SyncEventType.LocalCreate && e.path === path) {
                return e;
            }
        }
        return undefined;
    }

    /**
     * Returns whether there is an unsynced Create event queued at `path`.
     * A caller uses this to decide between displacing the local file vs.
     * merging it with a concurrent remote create.
     */
    public hasPendingCreateAt(path: RelativePath): boolean {
        return this.findLastCreate(path) !== undefined;
    }

    /**
     * Cancel the latest queued Create for `path`. Rejects its resolver
     * promise (so any dependent SyncLocal/Delete events that `await`ed
     * the future documentId skip themselves gracefully) and removes the
     * Create event from the queue. Returns true if a Create was found
     * and cancelled.
     */
    public cancelPendingCreate(path: RelativePath): boolean {
        const event = this.findLastCreate(path);
        if (event === undefined) return false;

        if (event.resolvers !== undefined) {
            event.resolvers.promise.catch(() => {
                /* suppressed — consumer may not be listening */
            });
            event.resolvers.reject(
                new Error(
                    "Create was cancelled — merged with concurrent remote create"
                )
            );
        }

        removeFromArray(this.events, event);
        return true;
    }

    private rejectAllPendingCreates(): void {
        for (const event of this.events) {
            if (event.type === SyncEventType.LocalCreate && event.resolvers !== undefined) {
                event.resolvers.promise.catch(() => { /* suppressed — consumer may not be listening */ });
                event.resolvers.reject(new Error("Create was cancelled"));
            }
        }
    }


    // Coalesce bursts of mutations into one persist per microtask. A drain
    // iteration can easily produce 10+ mutations; without this, we'd fire
    // 10 overlapping `save()` calls racing on the persistence backend.
    private saveInTheBackground(): void {
        if (this.savePending) return;
        this.savePending = true;
        queueMicrotask(() => {
            this.savePending = false;
            this.save();
        });
    }
}
