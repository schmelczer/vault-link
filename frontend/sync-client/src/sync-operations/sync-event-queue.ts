import type { Settings } from "../persistence/settings";
import type { Logger } from "../tracing/logger";
import { globsToRegexes } from "../utils/globs-to-regexes";
import { CONFLICT_PATH_REGEX } from "./conflict-path";
import { removeFromArray } from "../utils/remove-from-array";
import {
    DocumentWithPath,
    SyncEventType,
    type DocumentId,
    type DocumentRecord,
    type FileSyncEvent,
    type RelativePath,
    type StoredSyncState,
    type SyncEvent,
    type VaultUpdateId,
} from "./types";
import { MinCovered } from "../utils/data-structures/min-covered";


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

    public _lastSeenUpdateId: MinCovered;

    public constructor(
        private readonly settings: Settings,
        private readonly logger: Logger,
        initialState: Partial<StoredSyncState> | undefined,
        private readonly saveData: (data: StoredSyncState) => Promise<void>
    ) {
        this.ignorePatterns = [
            CONFLICT_PATH_REGEX, // conflict paths need to be resolved before they can be synced again
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
        this._lastSeenUpdateId = new MinCovered(initialState.lastSeenUpdateId ?? 0);

        this.logger.debug(`Loaded ${this.documents.size} documents and lastSeenUpdateId=${this._lastSeenUpdateId} from storage`);
    }

    public get lastSeenUpdateId(): VaultUpdateId {
        return this._lastSeenUpdateId.min;
    }

    public set lastSeenUpdateId(id: VaultUpdateId) {
        this._lastSeenUpdateId.add(id);
    }

    public get pendingUpdateCount(): number {
        return this.events.length;
    }

    public get syncedDocumentCount(): number {
        return this.documents.size;
    }

    public async enqueue(input: FileSyncEvent): Promise<void> {
        const path = (input.type === SyncEventType.RemoteChange) ? input.remoteVersion.relativePath : input.path;

        if (this.ignorePatterns.some((pattern) => pattern.test(path))) {
            this.logger.info(
                `Ignoring ${input.type} for ${path} as it matches ignore patterns`
            );
            return;
        }

        if (input.type === SyncEventType.RemoteChange) {
            this.events.push(input);
            return;
        }


        if (input.type === SyncEventType.LocalCreate) {
            this.events.push({ type: SyncEventType.LocalCreate, path, originalPath: path, resolvers: Promise.withResolvers() });
            return;
        }

        const lookupPath = (input.type === SyncEventType.LocalUpdate && input.oldPath) ? input.oldPath : path;
        const record = this.documents.get(lookupPath);

        // latest creation must take precedence as it's from the doc's latest generation
        const pendingDocumentId: Promise<DocumentId> | undefined =
            this.findLatestCreateForPath(lookupPath)?.resolvers.promise;

        const documentId: DocumentId | undefined =
            record?.documentId;


        if (pendingDocumentId === undefined && documentId === undefined) {
            // we can get here when deleting a local document after a remote update
            return;
        }

        if (input.type === SyncEventType.LocalDelete) {
            this.events.push({ type: SyncEventType.LocalDelete, documentId: pendingDocumentId ?? documentId! });
            return;
        }

        if (input.oldPath !== undefined) {
            if (pendingDocumentId !== undefined) {
                this.updatePendingCreatePath(input.oldPath, path);
            } else {
                this.documents.delete(input.oldPath);
                this.documents.set(path, record!);
                for (const e of this.events) {
                    // It already has a docId, so there can't be a pending create event for it 
                    if (e.type === SyncEventType.LocalUpdate && e.documentId === documentId) {
                        e.path = path;
                    }
                }
                await this.save();

            }
            return
        }

        this.events.push({ type: SyncEventType.LocalUpdate, documentId: pendingDocumentId ?? documentId!, path, originalPath: path });
    }



    public async next(): Promise<SyncEvent | undefined> {
        return this.events.shift();
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
        event.resolvers?.resolve(record.documentId);
    }

    /**
     * Update the settled document map and persist the new document version.
     */
    public setDocument(path: RelativePath, record: DocumentRecord): Promise<void> {
        this.documents.set(path, record);
        return this.save();

    }

    public removeDocument(path: RelativePath): Promise<void> {
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



    public getDocumentByDocumentIdOrFail(
        target: DocumentId
    ): DocumentWithPath {
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
    public getSettledDocumentByPath(path: RelativePath): DocumentRecord | undefined {
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
                    this.getDocumentByDocumentId(e.remoteVersion.documentId)?.path === path)
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
        this._lastSeenUpdateId.reset()
        await this.save();
    }

    public clearPending(): void {
        this.rejectAllPendingCreates();
        this.events.length = 0;
    }


    private updatePendingCreatePath(
        oldPath: RelativePath,
        newPath: RelativePath
    ): void {
        const createEvent = this.findLatestCreateForPath(oldPath);
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





    private rejectAllPendingCreates(): void {
        for (const event of this.events) {
            if (event.type === SyncEventType.LocalCreate && event.resolvers !== undefined) {
                event.resolvers.promise.catch(() => { /* suppressed — consumer may not be listening */ });
                event.resolvers.reject(new Error("Create was cancelled"));
            }
        }
    }


}
