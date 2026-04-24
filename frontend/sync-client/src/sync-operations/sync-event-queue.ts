import type { Settings } from "../persistence/settings";
import type { Logger } from "../tracing/logger";
import { globsToRegexes } from "../utils/globs-to-regexes";
import { CONFLICT_PATH_REGEX } from "./conflict-path";
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


    public readonly lastSeenUpdateId: VaultUpdateId;

    public constructor(
        private readonly settings: Settings,
        private readonly logger: Logger,
        initialState: Partial<StoredSyncState> | undefined,
        private readonly saveData: (data: StoredSyncState) => Promise<void>
    ) {
        this.ignorePatterns = [
            CONFLICT_PATH_REGEX,
            ...globsToRegexes(
                this.settings.getSettings().ignorePatterns,
                this.logger
            )
        ];

        this.settings.onSettingsChanged.add((newSettings) => {
            this.ignorePatterns = [
                CONFLICT_PATH_REGEX,
                ...globsToRegexes(newSettings.ignorePatterns, this.logger)
            ];
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

    public enqueue(input: FileSyncEvent): void {
        if (input.type === SyncEventType.RemoteUpdate) {
            this.events.push(input);
            return;
        }

        const { path } = input;

        if (this.isIgnored(path)) {
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
            this.getLatestCreatePromise(lookupPath) ?? record?.documentId;
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
                    // It already has a docId, so there can't be a pending create event for it 
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
        return this.events.shift();
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



    public getLatestCreatePromise(path: RelativePath): Promise<DocumentId> | undefined {
        const event = this.findLatestCreate(path);
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
                    this.getDocumentByDocumentId(e.remoteVersion.documentId)?.path === path)
        );
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




    private isIgnored(path: RelativePath): boolean {
        return this.ignorePatterns.some((pattern) => pattern.test(path));
    }

    public removeAllEventsForDocumentId(documentId: DocumentId): void {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (
                (e.type === SyncEventType.LocalUpdate &&
                    e.documentId === documentId) ||
                (e.type === SyncEventType.RemoteUpdate &&
                    e.remoteVersion.documentId === documentId) ||
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
        const createEvent = this.findLatestCreate(oldPath);
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

    private findLatestCreate(
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
        return this.findLatestCreate(path) !== undefined;
    }

    /**
     * Cancel the latest queued Create for `path`. Rejects its resolver
     * promise (so any dependent SyncLocal/Delete events that `await`ed
     * the future documentId skip themselves gracefully) and removes the
     * Create event from the queue. Returns true if a Create was found
     * and cancelled.
     */
    public cancelPendingCreate(path: RelativePath): boolean {
        const event = this.findLatestCreate(path);
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
