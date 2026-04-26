import type { Settings } from "../persistence/settings";
import type { Logger } from "../tracing/logger";
import { globsToRegexes } from "../utils/globs-to-regexes";
import { CONFLICT_PATH_REGEX } from "./conflict-path";
import { removeFromArray } from "../utils/remove-from-array";
import type { DocumentWithPath } from "./types";
import {
    SyncEventType,
    type DocumentId,
    type DocumentRecord,
    type FileSyncEvent,
    type RelativePath,
    type StoredSyncState,
    type SyncEvent,
    type VaultUpdateId
} from "./types";
import { MinCovered } from "../utils/data-structures/min-covered";

export class SyncEventQueue {
    private readonly _lastSeenUpdateId: MinCovered;

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

    // file creations for paths matching any of these patterns are ignored
    // because the user explicitly told us to ignore them.
    private userIgnorePatterns: RegExp[];

    // Whether `CONFLICT_PATH_REGEX` is applied at enqueue time. Conflict files
    // exist because the syncer set them aside; ignoring them at runtime
    // prevents resync churn. During an offline scan we DO want to surface them
    // so a stranded conflict file (e.g. one this client previously displaced
    // and was unable to re-sync) gets picked up as a normal new file.
    private ignoreConflictPaths = true;

    public constructor(
        private readonly settings: Settings,
        private readonly logger: Logger,
        initialState: Partial<StoredSyncState> | undefined,
        private readonly saveData: (data: StoredSyncState) => Promise<void>
    ) {
        this.userIgnorePatterns = globsToRegexes(
            this.settings.getSettings().ignorePatterns,
            this.logger
        );

        this.settings.onSettingsChanged.add((newSettings) => {
            this.userIgnorePatterns = globsToRegexes(
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
        this._lastSeenUpdateId = new MinCovered(
            initialState.lastSeenUpdateId ?? 0
        );

        this.logger.debug(
            `Loaded ${this.documents.size} documents and lastSeenUpdateId=${this._lastSeenUpdateId.min} from storage`
        );
    }

    public get pendingUpdateCount(): number {
        return this.events.length;
    }

    public get syncedDocumentCount(): number {
        return this.documents.size;
    }

    public get lastSeenUpdateId(): VaultUpdateId {
        return this._lastSeenUpdateId.min;
    }

    public set lastSeenUpdateId(id: VaultUpdateId) {
        this._lastSeenUpdateId.add(id);
    }

    /**
     * Toggle whether `CONFLICT_PATH_REGEX` filters incoming events. The
     * offline scan flips this off so a stranded conflict file gets surfaced
     * as a regular create; everywhere else conflict files stay ignored.
     */
    public setIgnoreConflictPaths(ignore: boolean): void {
        this.ignoreConflictPaths = ignore;
    }

    public async enqueue(input: FileSyncEvent): Promise<void> {
        const path =
            input.type === SyncEventType.RemoteChange
                ? input.remoteVersion.relativePath
                : input.path;

        if (this.userIgnorePatterns.some((pattern) => pattern.test(path))) {
            this.logger.info(
                `Ignoring ${input.type} for ${path} as it matches ignore patterns`
            );
            return;
        }

        if (input.type === SyncEventType.RemoteChange) {
            this.events.push(input);
            return;
        }

        // Drop bare LocalCreate events for conflict paths. Those are
        // produced by the watcher when the syncer's own write to a
        // displacement path slips past the `ExpectedFsEvents` filter
        // (e.g. a sync race where the watcher fires before
        // `expectCreate` was registered). Re-uploading them as new docs
        // would invent duplicates on the server. The legitimate way a
        // conflict-path doc enters the queue is via the displacement
        // rename's `LocalUpdate` (with `oldPath`) — that branch is
        // allowed through below so the tracked document's path follows
        // its file.
        if (
            this.ignoreConflictPaths &&
            CONFLICT_PATH_REGEX.test(path) &&
            input.type === SyncEventType.LocalCreate
        ) {
            this.logger.info(
                `Ignoring local-create for ${path} as it is a conflict path`
            );
            return;
        }

        if (input.type === SyncEventType.LocalCreate) {
            this.events.push({
                type: SyncEventType.LocalCreate,
                path,
                originalPath: path,
                resolvers: Promise.withResolvers()
            });
            return;
        }

        const lookupPath =
            input.type === SyncEventType.LocalUpdate &&
                input.oldPath !== undefined
                ? input.oldPath
                : path;
        const record = this.documents.get(lookupPath);

        // latest creation must take precedence as it's from the doc's latest generation
        const pendingDocumentId: Promise<DocumentId> | undefined =
            this.findLatestCreateForPath(lookupPath)?.resolvers.promise;

        const documentId: DocumentId | undefined = record?.documentId;

        if (pendingDocumentId === undefined && documentId === undefined) {
            // we can get here when deleting a local document after a remote update
            return;
        }

        if (input.type === SyncEventType.LocalDelete) {
            this.events.push({
                type: SyncEventType.LocalDelete,
                documentId: (pendingDocumentId ?? documentId)!
            });
            return;
        }

        let needsSave = false;
        if (input.oldPath !== undefined) {
            if (pendingDocumentId !== undefined) {
                this.updatePendingCreatePath(input.oldPath, path);
            } else {
                if (record === undefined) {
                    throw new Error(
                        "Unreachable: record must be defined for non-pending update"
                    );
                }
                this.documents.delete(input.oldPath);
                this.documents.set(path, record);
                for (const e of this.events) {
                    // It already has a docId, so there can't be a pending create event for it
                    if (
                        e.type === SyncEventType.LocalUpdate &&
                        e.documentId === documentId
                    ) {
                        e.path = path;
                    }
                }
                needsSave = true;
            }
        }

        // Push BEFORE awaiting `save()`. Callers fire `enqueue` with `void`
        // and immediately call `ensureDraining()`, which starts a drain that
        // synchronously shifts off the queue. If we awaited save first the
        // shift would see the queue empty, drain would exit, and the event
        // would never get processed until the next unrelated trigger.
        this.events.push({
            type: SyncEventType.LocalUpdate,
            documentId: (pendingDocumentId ?? documentId)!,
            path,
            originalPath: path
        });

        if (needsSave) {
            await this.save();
        }
    }

    public async next(): Promise<SyncEvent | undefined> {
        return this.events.shift();
    }


    /**
     * Return the next event without removing it. Drain uses this so the
     * event stays visible in the queue while it is being processed —
     * critical for `findLatestCreateForPath` to update an in-flight
     * `LocalCreate`'s path when a rename arrives mid-process. Also marks
     * the event as in-flight so dedup checks in `enqueue` know not to
     * fold a fresh content change into an event whose disk read already
     * happened.
     */
    public peekFront(): SyncEvent | undefined {
        return this.events[0];
    }

    /**
     * Remove a specific event after `peekFront`-based processing is done.
     * Idempotent — safe to call when the event was already taken out by
     * `resolveCreate` (which clears a same-path pending create that a
     * remote-create handler just absorbed).
     */
    public consumeEvent(event: SyncEvent): void {
        removeFromArray(this.events, event);
    }


    /**
     * Call once a create has been acknowledged by the server.
     */
    public async resolveCreate(
        event: Extract<SyncEvent, { type: SyncEventType.LocalCreate }>,
        record: DocumentRecord
    ): Promise<void> {
        removeFromArray(this.events, event); // in case the create event is still pending
        await this.setDocument(event.path, record);
        event.resolvers.resolve(record.documentId);
    }

    /**
     * Update the settled document map and persist the new document version.
     *
     * If the document is already tracked under a different path (e.g. after a
     * rename) the old entry is removed so the map stays keyed by the latest
     * disk path and `getDocumentByDocumentId` can't return a stale match.
     */
    public async setDocument(
        path: RelativePath,
        record: DocumentRecord
    ): Promise<void> {
        for (const [existingPath, existingRecord] of this.documents) {
            if (
                existingPath !== path &&
                existingRecord.documentId === record.documentId
            ) {
                this.documents.delete(existingPath);
            }
        }
        this.documents.set(path, record);
        return this.save();
    }

    public async removeDocument(path: RelativePath): Promise<void> {
        this.documents.delete(path);
        return this.save();
    }

    public getDocumentByDocumentId(
        target: DocumentId
    ): DocumentWithPath | undefined {
        for (const [path, record] of this.documents) {
            if (record.documentId === target) {
                return { path, record };
            }
        }
        return undefined;
    }

    public getDocumentByDocumentIdOrFail(target: DocumentId): DocumentWithPath {
        const result = this.getDocumentByDocumentId(target);
        if (!result) {
            throw new Error(`No document found with id ${target}`);
        }
        return result;
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
    public getSettledDocumentByPath(
        path: RelativePath
    ): DocumentRecord | undefined {
        return this.documents.get(path);
    }

    public allSettledDocuments(): Map<RelativePath, DocumentRecord> {
        return new Map(this.documents.entries());
    }

    public hasPendingEventsForPath(path: RelativePath): boolean {
        const record = this.documents.get(path);
        if (record === undefined) {
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
                (e.type === SyncEventType.RemoteChange &&
                    // we care about the local path not the remote
                    this.getDocumentByDocumentId(e.remoteVersion.documentId)
                        ?.path === path)
        );
    }

    public hasPendingLocalEventsForDocumentId(documentId: DocumentId): boolean {
        return this.events.some(
            (e) =>
                (e.type === SyncEventType.LocalUpdate &&
                    e.documentId === documentId) ||
                (e.type === SyncEventType.LocalDelete &&
                    e.documentId === documentId)
        );
    }



    public async clearAllState(): Promise<void> {
        this.clearPending();
        this.documents.clear();
        this._lastSeenUpdateId.reset();
        await this.save();
    }

    public clearPending(): void {
        this.rejectAllPendingCreates();
        this.events.length = 0;
    }

    public findLatestCreateForPath(
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

    public updatePendingCreatePath(
        oldPath: RelativePath,
        newPath: RelativePath
    ): void {
        const createEvent = this.findLatestCreateForPath(oldPath);
        if (createEvent === undefined) { return; }

        const { promise } = createEvent.resolvers;
        createEvent.path = newPath;

        for (const e of this.events) {
            if (
                e.type === SyncEventType.LocalUpdate &&
                e.documentId === promise
            ) {
                e.path = newPath;
            }
        }
    }

    private rejectAllPendingCreates(): void {
        for (const event of this.events) {
            if (event.type === SyncEventType.LocalCreate) {
                event.resolvers.promise.catch(() => {
                    /* suppressed — consumer may not be listening */
                });
                event.resolvers.reject(new Error("Create was cancelled"));
            }
        }
    }
}
