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
    private readonly events: SyncEvent[] = [];
    private readonly documents = new Map<RelativePath, DocumentRecord>();
    private readonly recentlyDeletedDocumentIds = new Set<DocumentId>();
    private lastSeenUpdateIds: CoveredValues;
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

        this.logger.debug(`Loaded ${this.documents.size} documents`);
    }

    public get size(): number {
        return this.events.length;
    }

    public get documentCount(): number {
        return this.documents.size;
    }

    public getLastSeenUpdateId(): VaultUpdateId {
        return this.lastSeenUpdateIds.min;
    }

    public addSeenUpdateId(value: number): void {
        const previousMin = this.lastSeenUpdateIds.min;
        this.lastSeenUpdateIds.add(value);
        if (previousMin !== this.lastSeenUpdateIds.min) {
            this.saveInTheBackground();
        }
    }

    public setLastSeenUpdateId(value: number): void {
        this.lastSeenUpdateIds.min = value;
        this.saveInTheBackground();
    }

    public getDocument(path: RelativePath): DocumentRecord | undefined {
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
        const record = this.documents.get(path);
        if (record !== undefined) {
            this.recentlyDeletedDocumentIds.add(record.documentId);
        }
        this.documents.delete(path);
        this.saveInTheBackground();
    }

    /**
     * Move a document from oldPath to newPath.
     * If the target path is occupied by a different document, it is removed
     * and its documentId is returned so the caller can handle the displacement.
     */
    public moveDocument(
        oldPath: RelativePath,
        newPath: RelativePath
    ): DocumentId | undefined {
        const record = this.documents.get(oldPath);
        if (record === undefined) return undefined;

        let displacedDocumentId: DocumentId | undefined = undefined;
        const existingAtTarget = this.documents.get(newPath);
        if (
            existingAtTarget !== undefined &&
            existingAtTarget.documentId !== record.documentId
        ) {
            displacedDocumentId = existingAtTarget.documentId;
            this.recentlyDeletedDocumentIds.add(displacedDocumentId);
            this.documents.delete(newPath);
        }

        this.documents.delete(oldPath);
        this.documents.set(newPath, record);
        this.saveInTheBackground();
        return displacedDocumentId;
    }

    public wasRecentlyDeleted(documentId: DocumentId): boolean {
        return this.recentlyDeletedDocumentIds.has(documentId);
    }

    public unmarkRecentlyDeleted(documentId: DocumentId): void {
        this.recentlyDeletedDocumentIds.delete(documentId);
    }


    public allDocuments(): [RelativePath, DocumentRecord][] {
        return Array.from(this.documents.entries());
    }

    public hasCreateEvent(path: RelativePath): boolean {
        return this.events.some(
            (e) => e.type === SyncEventType.Create && e.path === path
        );
    }

    public updateCreatePath(
        oldPath: RelativePath,
        newPath: RelativePath
    ): boolean {
        for (const event of this.events) {
            if (event.type === SyncEventType.Create && event.path === oldPath) {
                event.path = newPath;
                return true;
            }
        }
        return false;
    }

    public hasPendingEventsForPath(path: RelativePath): boolean {
        const record = this.documents.get(path);
        const docId = record?.documentId;
        return this.events.some(
            (e) =>
                (e.type === SyncEventType.Create && e.path === path) ||
                (e.type === SyncEventType.SyncLocal &&
                    docId !== undefined &&
                    e.documentId === docId) ||
                (e.type === SyncEventType.Delete &&
                    docId !== undefined &&
                    e.documentId === docId) ||
                (e.type === SyncEventType.SyncRemote &&
                    e.remoteVersion.relativePath === path)
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
        this.documents.clear();
        this.recentlyDeletedDocumentIds.clear();
        this.lastSeenUpdateIds = new CoveredValues(0);
        this.saveInTheBackground();
    }

    public clear(): void {
        this.events.length = 0;
        this.recentlyDeletedDocumentIds.clear();
    }

    public enqueue(event: SyncEvent): void {
        if (this.isIgnored(event)) return;

        if (event.type === SyncEventType.Create) {
            if (this.documents.has(event.path)) return;
            if (this.hasCreateEvent(event.path)) return;
        }

        this.events.push(event);
    }



    public next(): SyncEvent | undefined {
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
            if (documentId !== "") {
                this.removeAllEventsForDocumentId(documentId);
            }
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
                this.removeAllSyncLocalsForDocumentId(documentId);
                removeFromArray(this.events, deleteEvent);
                return deleteEvent;
            }

            // Coalesce multiple sync-locals for the same documentId to the last one
            const matching = this.events.filter(
                (e) =>
                    e.type === SyncEventType.SyncLocal &&
                    e.documentId === documentId
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
        if (event.type !== SyncEventType.Create) return false;
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

    private removeAllSyncLocalsForDocumentId(documentId: DocumentId): void {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (
                e.type === SyncEventType.SyncLocal &&
                e.documentId === documentId
            ) {
                // eslint-disable-next-line no-restricted-syntax -- Bulk removal by predicate, not single-item removal
                this.events.splice(i, 1);
            }
        }
    }

    private saveInTheBackground(): void {
        void this.save().catch((error: unknown) => {
            this.logger.error(`Error saving sync state: ${error}`);
        });
    }
}
