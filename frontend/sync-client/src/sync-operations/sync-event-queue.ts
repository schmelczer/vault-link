import type { Settings } from "../persistence/settings";
import type { Logger } from "../tracing/logger";
import { globsToRegexes } from "../utils/globs-to-regexes";
import { CoveredValues } from "../utils/data-structures/min-covered";
import { removeFromArray } from "../utils/remove-from-array";
import {
    SyncEventType,
    type DocumentId,
    type DocumentRecord,
    type RelativePath,
    type StoredSyncState,
    type SyncEvent,
    type VaultUpdateId,
} from "./types";

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
    // The paths for the events must always correspond to the latest
    // path on disk, so the path of each event may be updated multiple
    // times. 
    //
    // It maps pending changes onto the local filesystem.
    private readonly events: SyncEvent[] = [];

    // TODO: remove
    // Log the last seen update before which we've seen all ids so that
    // on the next startup, we can skip re-syncing what we have already 
    private lastSeenUpdateIds: CoveredValues;

    // file creations for paths matching any of these patterns will be ignored
    private ignorePatterns: RegExp[];

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

        const { lastSeenUpdateId } = initialState;


        this.lastSeenUpdateIds = new CoveredValues(
            Math.max(0, lastSeenUpdateId ?? 0)
        );

        for (const [, record] of this.documents) {
            this.lastSeenUpdateIds.add(record.parentVersionId);
        }

        this.logger.debug(`Loaded ${this.documents.size} documents and lastSeenUpdateId=${this.lastSeenUpdateIds.min}`);
    }

    public get size(): number {
        return this.events.length;
    }

    public get documentCount(): number {
        return this.documents.size;
    }

    public get lastSeenUpdateId(): VaultUpdateId {
        return this.lastSeenUpdateIds.min;
    }

    public set lastSeenUpdateId(value: number) {
        this.lastSeenUpdateIds.min = value;
        this.saveInTheBackground();
    }

    public addSeenUpdateId(value: number): void {
        const previousMin = this.lastSeenUpdateIds.min;
        this.lastSeenUpdateIds.add(value);
        if (previousMin !== this.lastSeenUpdateIds.min) {
            this.saveInTheBackground();
        }
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
     * Call once a create has been acknowledged by the server.
     */
    public resolveCreate(
        event: Extract<SyncEvent, { type: SyncEventType.Create }>,
        record: DocumentRecord
    ): void {
        const promise = event.resolvers?.promise;

        this.documents.set(event.path, record);
        event.resolvers?.resolve(record.documentId);

        if (promise !== undefined) {
            for (const e of this.events) {
                if (
                    (e.type === SyncEventType.SyncLocal || e.type === SyncEventType.Delete) &&
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
            if (event.type === SyncEventType.Create) {
                paths.add(event.path);
                if (event.resolvers !== undefined) {
                    pendingPaths.set(event.resolvers.promise, event.path);
                }
            } else if (event.type === SyncEventType.Delete) {
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
                (e.type === SyncEventType.Create && e.path === path) ||
                (e.type === SyncEventType.SyncLocal &&
                    e.documentId === docId) ||
                (e.type === SyncEventType.Delete &&
                    e.documentId === docId) ||
                (e.type === SyncEventType.SyncRemote &&
                    // we care about the local path not the remote
                    this.getDocumentByDocumentId(e.remoteVersion.documentId as DocumentId)?.path === path)
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
            lastSeenUpdateId: this.lastSeenUpdateIds.min
        });
    }

    public resetState(): void {
        this.rejectAllPendingCreates();
        this.documents.clear();
        this.lastSeenUpdateIds = new CoveredValues(0);
        this.saveInTheBackground();
    }

    public clear(): void {
        this.rejectAllPendingCreates();
        this.events.length = 0;
    }

    // todo: maybe move next() logic here to stop storing rubbish 
    public enqueue(event: SyncEvent): void { // new type
        if (this.isIgnored(event)) return;

        if (event.type === SyncEventType.SyncLocal) {
            const { path: newPath } = event;

            if (typeof event.documentId === "string") {
                const existing = this.getDocumentByDocumentId(event.documentId);
                if (!existing) {
                    throw new Error(`SyncLocal event for unknown documentId ${event.documentId}`);
                }

                if (this.documents.has(newPath)) {
                    throw new Error(`SyncLocal event for documentId ${event.documentId} has newPath ${newPath} which is already tracked by another document`);
                }

                if (existing.path !== newPath) {
                    this.documents.delete(existing.path);
                    this.documents.set(newPath, existing.record);
                    for (const e of this.events) {
                        if (
                            e.type === SyncEventType.SyncLocal &&
                            e.documentId === event.documentId
                        ) {
                            e.path = newPath;
                        }
                    }
                    this.saveInTheBackground();
                }
            } else {
                const oldPath = this.findCreatePathByPromise(event.documentId);
                if (oldPath !== undefined && oldPath !== newPath) {
                    this.updatePendingCreatePath(oldPath, newPath);
                }
            }
        }

        this.events.push(event);
    }



    public async next(): Promise<SyncEvent | undefined> {
        if (this.events.length === 0) return undefined;

        const [first] = this.events;

        // Creates are always returned immediately (FIFO)
        if (first.type === SyncEventType.Create) {
            this.events.shift();
            return first;
        }

        // Deletes are returned immediately; also discard any subsequent
        // events for the same documentId so stale broadcasts don't
        // resurrect the document
        if (first.type === SyncEventType.Delete) {
            this.events.shift();
            const { documentId } = first;
            this.removeAllEventsForDocumentId(await documentId);
            return first;
        }

        if (first.type === SyncEventType.SyncLocal) {
            const { documentId } = first;

            // If there's a later delete for the same documentId, discard
            // all sync-locals for that document and return the delete
            const deleteEvent = this.events.find(
                (e) =>
                    e.type === SyncEventType.Delete &&
                    e.documentId === documentId
            );
            if (deleteEvent !== undefined) {
                this.removeAllEventsForDocumentId(await documentId);
                return deleteEvent;
            }

            // Coalesce multiple sync-locals for the same documentId and
            // original path to the last one
            const matching = this.events.filter(
                (e) =>
                    e.type === SyncEventType.SyncLocal &&
                    e.documentId === documentId &&
                    e.originalPath === first.originalPath // can't coalesce moves as they can depend on each other so we have to sync them in the same order, could do topological sort but let's keep it simple for now
            );
            const result = matching[matching.length - 1];
            for (const item of matching) {
                removeFromArray(this.events, item);
            }
            return result;
        }

        // SyncRemote: coalesce multiple events for the same documentId to the last one
        const { documentId } = first.remoteVersion;
        const matching = this.events.filter(
            (e) =>
                e.type === SyncEventType.SyncRemote &&
                e.remoteVersion.documentId === documentId
        );
        const result = matching[matching.length - 1];
        for (const item of matching) {
            removeFromArray(this.events, item);
        }
        return result;
    }

    private isIgnored(event: SyncEvent): boolean {
        if (event.type !== SyncEventType.Create) {
            return false;
        }
        return this.ignorePatterns.some((pattern) => pattern.test(event.path));
    }

    private removeAllEventsForDocumentId(documentId: DocumentId): void {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (
                (e.type === SyncEventType.SyncLocal &&
                    e.documentId === documentId) ||
                (e.type === SyncEventType.SyncRemote &&
                    e.remoteVersion.documentId === documentId) ||
                (e.type === SyncEventType.Delete &&
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
                    e.type === SyncEventType.SyncLocal &&
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
                e.type === SyncEventType.Create &&
                e.resolvers?.promise === promise
            ) {
                return e.path;
            }
        }
        return undefined;
    }

    private findLastCreate(
        path: RelativePath
    ): Extract<SyncEvent, { type: SyncEventType.Create }> | undefined {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (e.type === SyncEventType.Create && e.path === path) {
                return e;
            }
        }
        return undefined;
    }

    private rejectAllPendingCreates(): void {
        for (const event of this.events) {
            if (event.type === SyncEventType.Create && event.resolvers !== undefined) {
                event.resolvers.promise.catch(() => { /* suppressed — consumer may not be listening */ });
                event.resolvers.reject(new Error("Create was cancelled"));
            }
        }
    }

    private saveInTheBackground(): void {
        void this.save().catch((error: unknown) => {
            this.logger.error(`Error saving sync state: ${error}`);
        });
    }
}
