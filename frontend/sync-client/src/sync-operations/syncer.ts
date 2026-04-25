import {
    SyncEventType,
    type DocumentId,
    type DocumentRecord,
    type SyncEvent,
    type RelativePath,
    type VaultUpdateId
} from "./types";
import type { Logger } from "../tracing/logger";
import { hash } from "../utils/hash";
import type { Settings } from "../persistence/settings";
import {
    MoveOnConflict,
    type FileOperations
} from "../file-operations/file-operations";
import { scheduleOfflineChanges } from "./offline-change-detector";
import { SyncResetError } from "../errors/sync-reset-error";
import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";
import type { WebSocketVaultUpdate } from "../services/types/WebSocketVaultUpdate";
import type { WebSocketManager } from "../services/websocket-manager";
import type { WebSocketClientMessage } from "../services/types/WebSocketClientMessage";
import { EventListeners } from "../utils/data-structures/event-listeners";
import type { SyncEventQueue } from "./sync-event-queue";
import type { SyncService } from "../services/sync-service";
import { FileNotFoundError } from "../errors/file-not-found-error";
import { HttpClientError } from "../errors/http-client-error";
import type { SyncHistory } from "../tracing/sync-history";
import {
    SyncStatus,
    SyncType,
    type CommonHistoryEntry
} from "../tracing/sync-history";
import { isBinary } from "../utils/is-binary";
import { isFileTypeMergable } from "../utils/is-file-type-mergable";
import { diff, reconcile } from "reconcile-text";
import type { ServerConfig } from "../services/server-config";
import type { FixedSizeDocumentCache } from "../utils/data-structures/fix-sized-cache";
import { base64ToBytes } from "byte-base64";
import type { DocumentUpdateResponse } from "../services/types/DocumentUpdateResponse";

export class Syncer {
    public readonly onRemainingOperationsCountChanged = new EventListeners<
        (remainingOperations: number) => unknown
    >();

    private readonly queue: SyncEventQueue;

    private runningScheduleSyncForOfflineChanges: Promise<void> | undefined;
    private drainPromise: Promise<void> | undefined;
    private isScanning = false;
    private previousRemainingOperationsCount = 0;

    public constructor(
        private readonly deviceId: string,
        private readonly logger: Logger,
        private readonly settings: Settings,
        private readonly webSocketManager: WebSocketManager,
        private readonly operations: FileOperations,
        private readonly syncService: SyncService,
        private readonly history: SyncHistory,
        private readonly contentCache: FixedSizeDocumentCache,
        private readonly serverConfig: ServerConfig,
        queue: SyncEventQueue
    ) {
        this.queue = queue;

        this.webSocketManager.onWebSocketStatusChanged.add((isConnected) => {
            if (isConnected) {
                this.sendHandshakeMessage();
            }
        });
        this.webSocketManager.onRemoteVaultUpdateReceived.add(
            this.syncRemotelyUpdatedFile.bind(this)
        );
    }

    public syncLocallyCreatedFile(relativePath: RelativePath): void {
        void this.queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: relativePath
        });
        this.ensureDraining();
    }

    public syncLocallyUpdatedFile({
        oldPath,
        relativePath
    }: {
        oldPath?: RelativePath;
        relativePath: RelativePath;
    }): void {
        void this.queue.enqueue({
            type: SyncEventType.LocalUpdate,
            path: relativePath,
            oldPath
        });
        this.ensureDraining();
    }

    public syncLocallyDeletedFile(relativePath: RelativePath): void {
        void this.queue.enqueue({
            type: SyncEventType.LocalDelete,
            path: relativePath
        });
        this.ensureDraining();
    }

    public async syncRemotelyUpdatedFile(
        message: WebSocketVaultUpdate
    ): Promise<void> {
        await this.scheduleSyncForOfflineChanges();

        void this.queue.enqueue({
            type: SyncEventType.RemoteChange,
            remoteVersion: message.document
        });

        this.ensureDraining();
    }

    public async scheduleSyncForOfflineChanges(): Promise<void> {
        if (this.runningScheduleSyncForOfflineChanges !== undefined) {
            this.logger.debug("Uploading local changes is already in progress");
            return this.runningScheduleSyncForOfflineChanges;
        }

        try {
            this.runningScheduleSyncForOfflineChanges =
                this.internalScheduleSyncForOfflineChanges();
            await this.runningScheduleSyncForOfflineChanges;
            this.logger.info(`All local changes have been applied remotely`);
        } catch (e) {
            if (e instanceof SyncResetError) {
                this.logger.info(
                    "Failed to apply local changes remotely due to a reset"
                );
                return;
            }
            this.logger.error(
                `Not all local changes have been applied remotely: ${e}`
            );
            throw e;
        }
    }

    public async waitUntilFinished(): Promise<void> {
        await this.runningScheduleSyncForOfflineChanges;
        // A drain that finishes can be immediately followed by a new one
        // (e.g. a remote event arriving), so re-check after each await.
        while (this.drainPromise !== undefined) {
            await this.drainPromise;
        }
    }

    public reset(): void {
        this.queue.clearPending();
        this.clearOfflineScanGate();
    }

    /**
     * Reset the "have we already scanned this session" gate so a later
     * `scheduleSyncForOfflineChanges()` actually performs a fresh scan
     * instead of returning the previous (resolved) promise. Called when
     * sync is paused so the next start picks up any offline edits made
     * while sync was off.
     */
    public clearOfflineScanGate(): void {
        const current = this.runningScheduleSyncForOfflineChanges;
        if (current !== undefined) {
            void current.finally(() => {
                if (this.runningScheduleSyncForOfflineChanges === current) {
                    this.runningScheduleSyncForOfflineChanges = undefined;
                }
            });
        }
    }

    private sendHandshakeMessage(): void {
        const message: WebSocketClientMessage = {
            type: "handshake",
            deviceId: this.deviceId,
            token: this.settings.getSettings().token,
            lastSeenVaultUpdateId: this.queue.lastSeenUpdateId
        };
        this.webSocketManager.sendHandshakeMessage(message);
    }

    private async internalScheduleSyncForOfflineChanges(): Promise<void> {
        this.isScanning = true;
        // Surface stranded conflict files (e.g. ones we displaced in a prior
        // session and never resynced) as regular creates during the scan; the
        // queue re-enables conflict filtering when we're done.
        this.queue.setIgnoreConflictPaths(false);
        try {
            while (this.drainPromise !== undefined) {
                await this.drainPromise;
            }
            await scheduleOfflineChanges(
                this.logger,
                this.operations,
                this.queue,
                (path) => {
                    this.syncLocallyCreatedFile(path);
                },
                (args) => {
                    this.syncLocallyUpdatedFile(args);
                },
                (path) => {
                    this.syncLocallyDeletedFile(path);
                }
            );
        } finally {
            this.queue.setIgnoreConflictPaths(true);
            this.isScanning = false;
        }

        this.ensureDraining();
    }

    private ensureDraining(): void {
        if (this.drainPromise !== undefined) return;
        if (this.isScanning) return;
        this.drainPromise = this.drain().finally(() => {
            this.drainPromise = undefined;
        });
    }

    private async drain(): Promise<void> {
        let event = await this.queue.next();
        while (event !== undefined) {
            try {
                await this.processEvent(event);
            } catch (e) {
                if (e instanceof SyncResetError) {
                    this.logger.info("Drain interrupted by sync reset");
                    return;
                }
                this.logger.error(
                    `Failed to process sync event ${event.type}: ${e}`
                );
            }
            this.notifyRemainingOperationsChanged();
            event = await this.queue.next();
        }
    }

    private async processEvent(event: SyncEvent): Promise<void> {
        if (!this.settings.getSettings().isSyncEnabled) {
            this.logger.info(
                `Skipping sync operation because sync is disabled`
            );
            return;
        }

        try {
            if (await this.skipIfOversized(event)) {
                return;
            }

            switch (event.type) {
                case SyncEventType.LocalCreate:
                    await this.processCreate(event);
                    break;
                case SyncEventType.LocalDelete:
                    await this.processDelete(event);
                    break;
                case SyncEventType.LocalUpdate:
                    await this.processLocalUpdate(event);
                    break;
                case SyncEventType.RemoteChange:
                    await this.processRemoteChange(event);
                    break;
            }
        } catch (e) {
            // The currently-processed event was already shifted off the queue
            // by drain() before processEvent ran. If it's a LocalCreate, any
            // queued Delete/Update events whose `documentId` is this Create's
            // resolvers.promise would `await` it forever once we return — so
            // settle the resolvers on every failure path before
            // dispatching/re-throwing. clearPending()'s rejectAllPendingCreates
            // walks the queue and so cannot reach this in-flight event.
            // Re-rejecting an already-resolved promise is a no-op, so it's
            // safe to call this unconditionally on the LocalCreate branch.
            if (event.type === SyncEventType.LocalCreate) {
                event.resolvers.promise.catch(() => {
                    /* suppressed */
                });
                event.resolvers.reject(
                    new Error(`Create was cancelled: ${e}`)
                );
            }

            if (e instanceof FileNotFoundError) {
                this.logger.info(
                    `Skipping sync event '${event.type}' because the file no longer exists`
                );
                return;
            }
            if (e instanceof HttpClientError) {
                this.logger.error(
                    `Server rejected ${event.type} request: ${e.message}`
                );
                return;
            }
            throw e;
        }
    }

    private async skipIfOversized(event: SyncEvent): Promise<boolean> {
        let sizeInBytes = 0;
        let relativePath: RelativePath = "";

        switch (event.type) {
            case SyncEventType.LocalDelete:
                return false;
            case SyncEventType.LocalCreate:
            case SyncEventType.LocalUpdate:
                sizeInBytes = await this.operations.getFileSize(event.path);
                relativePath = event.path;
                break;
            case SyncEventType.RemoteChange:
                if (event.remoteVersion.isDeleted) return false;
                sizeInBytes = event.remoteVersion.contentSize;
                ({ relativePath } = event.remoteVersion);
                break;
        }

        const oversizedEntry = this.getHistoryEntryForSkippedOversizedFile(
            sizeInBytes,
            relativePath
        );
        if (oversizedEntry === undefined) return false;

        this.history.addHistoryEntry(oversizedEntry);

        if (event.type === SyncEventType.LocalCreate) {
            event.resolvers.promise.catch(() => {
                /* suppressed */
            });
            event.resolvers.reject(new Error("Create was cancelled"));
        }

        return true;
    }

    private getHistoryEntryForSkippedOversizedFile(
        sizeInBytes: number,
        relativePath: RelativePath
    ): CommonHistoryEntry | undefined {
        const sizeInMB = Math.round(sizeInBytes / 1024 / 1024);
        const { maxFileSizeMB } = this.settings.getSettings();
        if (sizeInMB > maxFileSizeMB) {
            return {
                status: SyncStatus.SKIPPED,
                details: {
                    type: SyncType.SKIPPED as const,
                    relativePath
                },
                message: `File size of ${sizeInMB} MB exceeds the maximum file size limit of ${maxFileSizeMB} MB`
            };
        }
    }

    private async processCreate(
        event: Extract<SyncEvent, { type: SyncEventType.LocalCreate }>
    ): Promise<void> {
        const effectivePath = event.path;
        const contentBytes = await this.operations.read(effectivePath);
        const contentHash = await hash(contentBytes);

        const response = await this.syncService.create({
            relativePath: event.originalPath,
            lastSeenVaultUpdateId: this.queue.lastSeenUpdateId,
            contentBytes
        });

        await this.handleMaybeMergingResponse({
            path: effectivePath,
            response,
            contentHash,
            originalContentBytes: contentBytes,
            createEvent: event
        });

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: { type: SyncType.CREATE, relativePath: effectivePath },
            message:
                response.type === "MergingUpdate"
                    ? "Created file and merged with existing remote version"
                    : "Successfully created file on the server",
            author: response.userId,
            timestamp: new Date(response.updatedDate)
        });
    }

    private async processDelete(
        event: Extract<SyncEvent, { type: SyncEventType.LocalDelete }>
    ): Promise<void> {
        const documentId = await event.documentId;

        const doc = this.queue.getDocumentByDocumentIdOrFail(documentId);
        const relativePath = doc.path;

        const response = await this.syncService.delete({
            documentId,
            relativePath
        });

        await this.queue.removeDocument(doc.path);
        this.queue.lastSeenUpdateId = response.vaultUpdateId;

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.DELETE,
                relativePath
            },
            message: "Successfully deleted file on the server",
            author: response.userId
        });
    }

    private async processLocalUpdate(
        event: Extract<SyncEvent, { type: SyncEventType.LocalUpdate }>
    ): Promise<void> {
        const documentId = await event.documentId;

        const { path: diskPath, record } =
            this.queue.getDocumentByDocumentIdOrFail(documentId);

        const contentBytes = await this.operations.read(diskPath);
        const contentHash = await hash(contentBytes);

        const hashChanged = contentHash !== record.remoteHash;
        const pathChanged = record.remoteRelativePath !== event.originalPath;

        if (!hashChanged && !pathChanged) {
            this.logger.debug(
                `File hash of ${diskPath} matches last synced version; no need to sync`
            );
            return;
        }

        const response = await this.sendUpdate({
            record,
            relativePath: event.originalPath,
            contentBytes
        });

        this.queue.lastSeenUpdateId = response.vaultUpdateId;

        await this.handleMaybeMergingResponse({
            path: diskPath,
            response,
            contentHash,
            originalContentBytes: contentBytes
        });

        const isMerge = "type" in response && response.type === "MergingUpdate";
        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.UPDATE,
                relativePath: diskPath
            },
            message: isMerge
                ? "Updated file and merged with remote changes"
                : "Successfully updated file on the server",
            author: response.userId,
            timestamp: new Date(response.updatedDate)
        });
    }

    private async handleMaybeMergingResponse({
        path,
        response,
        contentHash,
        originalContentBytes,
        createEvent
    }: {
        path: RelativePath;
        response: DocumentUpdateResponse;
        contentHash: string;
        originalContentBytes: Uint8Array;
        // When processing a Create, pass the originating event so its
        // `resolvers` promise can be fulfilled (or rejected, on a deleted
        // response)
        createEvent?: Extract<SyncEvent, { type: SyncEventType.LocalCreate }>;
    }): Promise<void> {
        const record = {
            documentId: response.documentId,
            parentVersionId: response.vaultUpdateId,
            remoteRelativePath: response.relativePath
        };
        let remoteHash = "";

        if ("type" in response && response.type === "MergingUpdate") {
            const responseBytes = base64ToBytes(response.contentBase64);
            await this.operations.write(
                path,
                originalContentBytes,
                responseBytes
            );

            remoteHash = await hash(responseBytes);

            await this.updateCache(response.vaultUpdateId, responseBytes, path);
        } else {
            // Fast-forward update: no merge needed
            remoteHash = contentHash;

            await this.updateCache(
                response.vaultUpdateId,
                originalContentBytes,
                path
            );
        }

        if (createEvent === undefined) {
            // a http response will always be more up-to-date than any queued remote update
            // move will always move to the relative path when MoveOnConflict.EXISTING is given
            await this.operations.move(
                path,
                response.relativePath,
                MoveOnConflict.EXISTING
            );

            await this.queue.setDocument(response.relativePath, {
                ...record,
                remoteHash
            });
        } else {
            // The server may have deconflicted the path on create (e.g.
            // another client raced us to the same path and won). Move the
            // local file to match the server-assigned path so the queue's
            // disk-path key, the on-disk path, and `remoteRelativePath` stay
            // consistent. Without this, a later remote create at the
            // originally-requested path would see a phantom local conflict
            // and stash the new file under a `conflict-<uuid>-` path.
            if (response.relativePath !== createEvent.path) {
                await this.operations.move(
                    createEvent.path,
                    response.relativePath,
                    MoveOnConflict.EXISTING
                );
                createEvent.path = response.relativePath;
            }
            await this.queue.resolveCreate(createEvent, {
                ...record,
                remoteHash
            });
        }

        this.queue.lastSeenUpdateId = response.vaultUpdateId;
    }

    private async processRemoteChange(
        event: Extract<SyncEvent, { type: SyncEventType.RemoteChange }>
    ): Promise<void> {
        const { remoteVersion } = event;
        const documentWithPath = this.queue.getDocumentByDocumentId(
            remoteVersion.documentId
        );

        if (remoteVersion.isDeleted) {
            if (documentWithPath === undefined) {
                // trying to delete a document we've already scheduled for deletion locally
                return;
            }
            return this.processRemoteDelete(
                documentWithPath.path,
                remoteVersion
            );
        }

        if (
            (documentWithPath?.record.parentVersionId ?? 0) >=
            remoteVersion.vaultUpdateId
        ) {
            this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;
            this.logger.debug(
                `Document ${remoteVersion.relativePath} is already up-to-date or has newer local changes; skipping remote update`
            );
            return;
        }

        if (documentWithPath !== undefined) {
            // must be the update to an existing doc
            return this.processRemoteUpdate(
                documentWithPath.path,
                documentWithPath.record,
                remoteVersion
            );
        }

        const pendingCreate = this.queue.findLatestCreateForPath(
            remoteVersion.relativePath
        );

        if (pendingCreate === undefined) {
            return this.processRemoteCreateForNewDocument(remoteVersion);
        } else {
            return this.processRemoteCreateForPendingDocument(
                remoteVersion,
                pendingCreate
            );
        }
    }

    private async processRemoteDelete(
        path: RelativePath,
        remoteVersion: DocumentVersionWithoutContent
    ): Promise<void> {
        await this.operations.delete(path);
        await this.queue.removeDocument(path);

        this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.DELETE,
                relativePath: path
            },
            message:
                "Successfully deleted file which had been deleted remotely",
            author: remoteVersion.userId,
            timestamp: new Date(remoteVersion.updatedDate)
        });
    }

    private async processRemoteUpdate(
        path: RelativePath,
        record: DocumentRecord,
        remoteVersion: DocumentVersionWithoutContent
    ): Promise<void> {
        // wait for a local edit to do the actual updating here, so we can't even update the lastSeenUpdateId here
        const conflictingDoc = this.queue.getSettledDocumentByPath(
            remoteVersion.relativePath
        );
        const actualPath = await this.operations.move(
            path,
            remoteVersion.relativePath,
            (conflictingDoc?.parentVersionId ?? 0) < remoteVersion.vaultUpdateId
                ? MoveOnConflict.EXISTING
                : MoveOnConflict.NEW
        );
        if (
            !this.queue.hasPendingLocalEventsForDocumentId(
                remoteVersion.documentId
            )
        ) {
            // no local changes — operations.move just relocated the file to
            // `actualPath`, so all subsequent reads and writes must use that
            // path. Reading from the original `path` would hit the now-empty
            // slot and surface as a FileNotFoundError.
            const currentContent = await this.operations.read(actualPath);
            const remoteContent =
                await this.syncService.getDocumentVersionContent({
                    documentId: remoteVersion.documentId,
                    vaultUpdateId: remoteVersion.vaultUpdateId
                });
            await this.operations.write(
                actualPath,
                currentContent,
                remoteContent
            );

            await this.updateCache(
                remoteVersion.vaultUpdateId,
                remoteContent,
                actualPath
            );
            await this.queue.setDocument(actualPath, {
                ...record,
                parentVersionId: remoteVersion.vaultUpdateId,
                remoteRelativePath: actualPath,
                remoteHash: await hash(remoteContent)
            });
            this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;
        } // else we don't need to update the content, a subsequent local update will do that
        else {
            void this.syncRemotelyUpdatedFile({
                // schedule it so that the lastSeenUpdateId remains consistent
                document: remoteVersion
            });



            await this.queue.setDocument(actualPath, {
                ...record,
                remoteRelativePath: actualPath
            });
        }


        if (actualPath !== path) {
            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: {
                    type: SyncType.MOVE,
                    relativePath: actualPath,
                    movedFrom: path
                },
                message: `File was renamed remotely from ${path} to ${actualPath}`,
                author: remoteVersion.userId,
                timestamp: new Date(remoteVersion.updatedDate)
            });
        } else {
            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: {
                    type: SyncType.UPDATE,
                    relativePath: actualPath
                },
                message: "Successfully applied remote update",
                author: remoteVersion.userId,
                timestamp: new Date(remoteVersion.updatedDate)
            });
        }
    }

    private async processRemoteCreateForNewDocument(
        remoteVersion: DocumentVersionWithoutContent
    ): Promise<void> {
        const remoteContent = await this.syncService.getDocumentVersionContent({
            documentId: remoteVersion.documentId,
            vaultUpdateId: remoteVersion.vaultUpdateId
        });

        const conflictingDoc = this.queue.getSettledDocumentByPath(
            remoteVersion.relativePath
        );

        const actualPath = await this.operations.create(
            remoteVersion.relativePath,
            remoteContent,
            (conflictingDoc?.parentVersionId ?? 0) < remoteVersion.vaultUpdateId
                ? MoveOnConflict.EXISTING
                : MoveOnConflict.NEW
        );

        await this.updateCache(
            remoteVersion.vaultUpdateId,
            remoteContent,
            actualPath
        );

        const contentHash = await hash(remoteContent);
        await this.queue.setDocument(actualPath, {
            documentId: remoteVersion.documentId,
            parentVersionId: remoteVersion.vaultUpdateId,
            remoteHash: contentHash,
            remoteRelativePath: remoteVersion.relativePath
        });

        this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.CREATE,
                relativePath: actualPath
            },
            message:
                "Successfully downloaded remote file which hadn't existed locally",
            author: remoteVersion.userId,
            timestamp: new Date(remoteVersion.updatedDate)
        });
    }

    // A remote create landed at a path where we have an unsynced local
    // create. This might be becuase there's another sync client running.
    // We must avoid duplicating files.
    private async processRemoteCreateForPendingDocument(
        remoteVersion: DocumentVersionWithoutContent,
        pendingCreateEvent: Extract<
            SyncEvent,
            { type: SyncEventType.LocalCreate }
        >
    ): Promise<void> {
        const remoteContent = await this.syncService.getDocumentVersionContent({
            documentId: remoteVersion.documentId,
            vaultUpdateId: remoteVersion.vaultUpdateId
        });
        const remoteHash = await hash(remoteContent);

        const path = remoteVersion.relativePath;
        const currentContent = await this.operations.read(
            pendingCreateEvent.path
        );

        await this.operations.write(path, currentContent, remoteContent);
        await this.updateCache(
            remoteVersion.vaultUpdateId,
            remoteContent,
            path
        );

        await this.queue.resolveCreate(pendingCreateEvent, {
            documentId: remoteVersion.documentId,
            parentVersionId: remoteVersion.vaultUpdateId,
            remoteHash,
            remoteRelativePath: path
        });
        this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.UPDATE,
                relativePath: path
            },
            message: `Adopted remote create at ${path}`,
            author: remoteVersion.userId,
            timestamp: new Date(remoteVersion.updatedDate)
        });
    }

    private async sendUpdate({
        record,
        relativePath,
        contentBytes
    }: {
        record: DocumentRecord;
        relativePath: RelativePath;
        contentBytes: Uint8Array;
    }): Promise<DocumentUpdateResponse> {
        const isText =
            !isBinary(contentBytes) &&
            isFileTypeMergable(
                relativePath,
                (await this.serverConfig.getConfig()).mergeableFileExtensions
            );

        const cachedVersion = this.contentCache.get(record.parentVersionId);

        if (isText && cachedVersion !== undefined) {
            return this.syncService.putText({
                documentId: record.documentId,
                parentVersionId: record.parentVersionId,
                relativePath,
                content: diff(
                    new TextDecoder().decode(cachedVersion),
                    new TextDecoder().decode(contentBytes)
                )
            });
        }

        return this.syncService.putBinary({
            documentId: record.documentId,
            parentVersionId: record.parentVersionId,
            relativePath,
            contentBytes
        });
    }

    private async updateCache(
        updateId: VaultUpdateId,
        contentBytes: Uint8Array,
        filePath: RelativePath
    ): Promise<void> {
        if (
            isFileTypeMergable(
                filePath,
                (await this.serverConfig.getConfig()).mergeableFileExtensions
            ) &&
            !isBinary(contentBytes)
        ) {
            this.contentCache.put(updateId, contentBytes);
        }
    }

    private notifyRemainingOperationsChanged(): void {
        const currentCount = this.queue.pendingUpdateCount;
        if (this.previousRemainingOperationsCount !== currentCount) {
            this.previousRemainingOperationsCount = currentCount;
            this.onRemainingOperationsCountChanged.trigger(currentCount);
        }
    }
}
