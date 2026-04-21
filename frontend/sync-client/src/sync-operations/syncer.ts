import {
    SyncEventType,
    type DocumentId,
    type DocumentRecord,
    type SyncEvent,
    type RelativePath,
    type VaultUpdateId,
} from "./types";
import type { Logger } from "../tracing/logger";
import { hash } from "../utils/hash";
import type { Settings } from "../persistence/settings";
import type { FileOperations } from "../file-operations/file-operations";
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
import type {
    SyncHistory
} from "../tracing/sync-history";
import {
    SyncStatus,
    SyncType,
    type CommonHistoryEntry
} from "../tracing/sync-history";
import { isBinary } from "../utils/is-binary";
import { isFileTypeMergable } from "../utils/is-file-type-mergable";
import { diff } from "reconcile-text";
import type { ServerConfig } from "../services/server-config";
import type { FixedSizeDocumentCache } from "../utils/data-structures/fix-sized-cache";
import { base64ToBytes } from "byte-base64";
import type { DocumentUpdateResponse } from "../services/types/DocumentUpdateResponse";

export class Syncer {
    public readonly onRemainingOperationsCountChanged = new EventListeners<
        (remainingOperations: number) => unknown
    >();

    private readonly queue: SyncEventQueue;

    private _isFirstSyncComplete = false;
    private runningScheduleSyncForOfflineChanges: Promise<void> | undefined;
    private draining: Promise<void> | undefined;
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
            } else {
                this.runningScheduleSyncForOfflineChanges = undefined;
            }
        });
        this.webSocketManager.onRemoteVaultUpdateReceived.add(
            this.syncRemotelyUpdatedFile.bind(this)
        );
    }

    public get isFirstSyncComplete(): boolean {
        return this._isFirstSyncComplete;
    }

    public hasPendingOperationsForDocument(relativePath: string): boolean {
        return this.queue.hasPendingEventsForPath(relativePath);
    }

    public syncLocallyCreatedFile(relativePath: RelativePath): void {
        this.queue.enqueue({ type: SyncEventType.Create, path: relativePath });
        this.ensureDraining();
    }

    public syncLocallyDeletedFile(relativePath: RelativePath): void {
        this.queue.enqueue({
            type: SyncEventType.Delete,
            path: relativePath,
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
        this.queue.enqueue({ type: SyncEventType.SyncLocal, path: relativePath, oldPath });
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
        // Loop until the draining promise stabilises — new drains can be
        // chained by events enqueued during processing
        let current = this.draining;
        while (current !== undefined) {
            await current;
            if (this.draining === current) break;
            current = this.draining;
        }
    }

    public async syncRemotelyUpdatedFile(
        message: WebSocketVaultUpdate
    ): Promise<void> {
        try {
            await this.scheduleSyncForOfflineChanges();

            for (const remoteVersion of message.documents) {
                this.queue.enqueue({
                    type: SyncEventType.SyncRemote,
                    remoteVersion
                });
            }

            if (message.isInitialSync) {
                this._isFirstSyncComplete = true;
            }

            await this.scheduleDrain();
        } catch (e) {
            if (e instanceof SyncResetError) {
                this.logger.info(
                    "Failed to sync remotely updated file due to a reset"
                );
                return;
            }
            this.logger.error(`Failed to sync remotely updated file: ${e}`);
        }
    }

    public reset(): void {
        this._isFirstSyncComplete = false;
        this.queue.clear();
        this.runningScheduleSyncForOfflineChanges = undefined;
        // Do not set this.draining = undefined — the in-flight drain will
        // exit naturally (SyncResetError or empty queue) and the promise
        // chain stays intact, preventing concurrent drain invocations
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
        await scheduleOfflineChanges(
            { logger: this.logger, operations: this.operations, queue: this.queue },
            (path) => this.syncLocallyCreatedFile(path),
            (args) => this.syncLocallyUpdatedFile(args),
            (path) => this.syncLocallyDeletedFile(path),
        );

        await this.scheduleDrain();
    }



    private ensureDraining(): void {
        this.draining = (this.draining ?? Promise.resolve()).then(
            async () => this.drain()
        );
    }

    private async scheduleDrain(): Promise<void> {
        this.ensureDraining();
        await this.draining;
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
            switch (event.type) {
                case SyncEventType.Create:
                    await this.processCreate(event);
                    break;
                case SyncEventType.Delete:
                    await this.processDelete(event);
                    break;
                case SyncEventType.SyncLocal:
                    await this.processSyncLocal(event);
                    break;
                case SyncEventType.SyncRemote:
                    await this.processSyncRemote(event);
                    break;
            }
        } catch (e) {
            if (e instanceof FileNotFoundError) {
                this.logger.info(
                    `Skipping sync event '${event.type}' because the file no longer exists`
                );
                if (event.type === SyncEventType.Create) {
                    event.resolvers?.promise.catch(() => { });
                    event.resolvers?.reject(new Error("Create was cancelled"));
                }
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



    private async processCreate(
        event: Extract<SyncEvent, { type: SyncEventType.Create }>
    ): Promise<void> {
        const effectivePath = event.path;
        const contentBytes = await this.operations.read(effectivePath);
        const contentHash = await hash(contentBytes);

        const oversizedEntry = this.getHistoryEntryForSkippedOversizedFile(
            contentBytes.byteLength,
            effectivePath
        );
        if (oversizedEntry !== undefined) {
            this.history.addHistoryEntry(oversizedEntry);
            event.resolvers?.promise.catch(() => { });
            event.resolvers?.reject(new Error("Create was cancelled"));
            return;
        }

        const response = await this.syncService.create({
            relativePath: event.originalPath,
            contentBytes
        });


        // Handle concurrent move & creation: the server merged our create
        // with an existing document that we also have locally at a different path
        const existingDoc = this.queue.getDocumentByDocumentId(
            response.documentId
        );

        // need to merge in db
        if (existingDoc !== undefined && existingDoc.path !== effectivePath) {
            //     this.logger.info(
            //         `Merging existing document ${existingDoc.path} into ${effectivePath} after concurrent move & creation`
            //     );
            //     await this.operations.delete(existingDoc.path);
            //     this.queue.removeDocument(existingDoc.path);
            //     if (!this.queue.getDocumentByDocumentId(existingDoc.record.documentId)) {
            //         this.queue.removeAllEventsForDocumentId(existingDoc.record.documentId);
            //     }
            // }
        }


        await this.handleMaybeMergingResponse({
            path: effectivePath,
            response,
            contentHash,
            originalContentBytes: contentBytes
        });

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: { type: SyncType.CREATE, relativePath: effectivePath },
            message: response.type === "MergingUpdate"
                ? "Created file and merged with existing remote version"
                : "Successfully created file on the server",
            author: response.userId,
            timestamp: new Date(response.updatedDate)
        });
    }

    private async processDelete(
        event: Extract<SyncEvent, { type: SyncEventType.Delete }>
    ): Promise<void> {
        let documentId: DocumentId;
        if (typeof event.documentId === "string") {
            documentId = event.documentId;
        } else {
            try {
                documentId = await event.documentId;
            } catch {
                this.logger.debug(
                    "Skipping delete for a document whose create was cancelled"
                );
                return;
            }
        }

        const doc = this.queue.getDocumentByDocumentId(documentId);
        if (doc === undefined) {
            this.logger.debug(
                `Skipping delete for unknown documentId ${documentId}`
            );
            return;
        }
        const relativePath = doc.path;

        const response = await this.syncService.delete({
            documentId,
            relativePath
        });

        this.queue.removeDocument(doc.path);

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

    private async processSyncLocal(
        event: Extract<SyncEvent, { type: SyncEventType.SyncLocal }>
    ): Promise<void> {
        let documentId: DocumentId;
        if (typeof event.documentId === "string") {
            documentId = event.documentId;
        } else {
            try {
                documentId = await event.documentId;
            } catch {
                this.logger.debug(
                    "Skipping sync-local for a document whose create was cancelled"
                );
                return;
            }
        }

        const doc = this.queue.getDocumentByDocumentId(documentId);

        if (doc === undefined) {
            this.logger.debug(
                `Skipping sync-local for unknown document ${documentId}`
            );
            return;
        }

        const { path: diskPath, record } = doc;

        // Read file from the current disk path
        const contentBytes = await this.operations.read(diskPath);
        const contentHash = await hash(contentBytes);

        // Upload using the original path
        const uploadPath = event.originalPath;

        const pathChanged =
            record.remoteRelativePath !== undefined &&
            record.remoteRelativePath !== uploadPath;

        if (contentHash === record.remoteHash && !pathChanged) {
            this.logger.debug(
                `File hash of ${diskPath} matches last synced version; no need to sync`
            );
            return;
        }

        const response = await this.sendUpdate(
            record,
            uploadPath,
            contentBytes
        );

        await this.handleMaybeMergingResponse({
            path: diskPath,
            response,
            contentHash,
            originalContentBytes: contentBytes
        });


        const isMerge =
            "type" in response && response.type === "MergingUpdate";
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

    private async processSyncRemote(
        event: Extract<SyncEvent, { type: SyncEventType.SyncRemote }>
    ): Promise<void> {
        const { remoteVersion } = event;
        const existingDoc = this.queue.getDocumentByDocumentId(
            remoteVersion.documentId
        );

        if (existingDoc !== undefined) {
            if (
                existingDoc.record.parentVersionId >=
                remoteVersion.vaultUpdateId
            ) {
                this.logger.debug(
                    `Document ${existingDoc.path} is already up-to-date`
                );
                return;
            }

            await this.processRemoteUpdateForExistingDocument(
                existingDoc.path,
                existingDoc.record,
                remoteVersion
            );
            return;
        }

        if (remoteVersion.isDeleted) {
            this.logger.debug(
                `Document ${remoteVersion.relativePath} has been deleted remotely, no need to sync`
            );
            return;
        }

        await this.processRemoteUpdateForNewDocument(remoteVersion);
    }

    private async processRemoteUpdateForExistingDocument(
        currentPath: RelativePath,
        record: DocumentRecord,
        remoteVersion: DocumentVersionWithoutContent
    ): Promise<void> {
        if (remoteVersion.isDeleted) {
            // Check for local changes before deleting
            let hasLocalChanges = false;
            try {
                const contentBytes = await this.operations.read(currentPath);
                const contentHash = await hash(contentBytes);
                hasLocalChanges = record.remoteHash !== contentHash;
            } catch (e) {
                if (!(e instanceof FileNotFoundError)) throw e;
            }

            if (hasLocalChanges) {
                // Local changes survive; re-upload as a new document
                this.queue.removeDocument(currentPath);
                this.syncLocallyCreatedFile(currentPath);
                return;
            }

            await this.operations.delete(currentPath);
            this.queue.removeDocument(currentPath);

            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: {
                    type: SyncType.DELETE,
                    relativePath: currentPath
                },
                message:
                    "Successfully deleted file which had been deleted remotely",
                author: remoteVersion.userId,
                timestamp: new Date(remoteVersion.updatedDate)
            });
            return;
        }

        // Fetch the latest full version from the server
        const fullVersion = await this.syncService.get({
            documentId: remoteVersion.documentId
        });

        // The document may have been deleted between the broadcast
        // and the fetch — handle it the same as a remote delete
        if (fullVersion.isDeleted) {
            const contentBytes = await this.operations.read(currentPath);
            const localHash = await hash(contentBytes);
            if (localHash !== record.remoteHash) {
                this.queue.removeDocument(currentPath);
                this.syncLocallyCreatedFile(currentPath);
            } else {
                await this.operations.delete(currentPath);
                this.queue.removeDocument(currentPath);
            }
            return;
        }

        const contentBytes = await this.operations.read(currentPath);
        const contentHash = await hash(contentBytes);

        const hasLocalChanges = record.remoteHash !== contentHash;

        if (hasLocalChanges) {
            const response = await this.sendUpdate(
                record,
                currentPath,
                contentBytes
            );

            await this.handleMaybeMergingResponse({
                path: currentPath,
                response,
                contentHash,
                originalContentBytes: contentBytes
            });


            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: {
                    type: SyncType.UPDATE,
                    relativePath: currentPath
                },
                message: "Merged local changes with remote update",
                author: response.userId,
                timestamp: new Date(response.updatedDate)
            });
        } else {
            const responseBytes = base64ToBytes(fullVersion.contentBase64);

            // Handle remote path change
            let actualPath = currentPath;
            if (
                fullVersion.relativePath !== currentPath &&
                record.remoteRelativePath === currentPath
            ) {
                actualPath = fullVersion.relativePath;
                await this.operations.delete(fullVersion.relativePath);
                await this.operations.move(
                    currentPath,
                    fullVersion.relativePath
                );
            }

            await this.operations.write(
                actualPath,
                contentBytes,
                responseBytes
            );

            // Re-read and re-hash after write (the 3-way merge may produce different content)
            const afterWriteBytes = await this.operations.read(actualPath);
            const afterWriteHash = await hash(afterWriteBytes);

            this.queue.setDocument(actualPath, {
                documentId: fullVersion.documentId,
                parentVersionId: fullVersion.vaultUpdateId,
                remoteHash: afterWriteHash,
                remoteRelativePath: fullVersion.relativePath
            });

            // If the path changed, remove the old entry
            if (actualPath !== currentPath) {
                this.queue.removeDocument(currentPath);
            }

            await this.updateCache(
                fullVersion.vaultUpdateId,
                responseBytes,
                actualPath
            );

            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details:
                    actualPath !== currentPath
                        ? {
                            type: SyncType.MOVE,
                            relativePath: actualPath,
                            movedFrom: currentPath
                        }
                        : {
                            type: SyncType.UPDATE,
                            relativePath: actualPath
                        },
                message:
                    "Successfully downloaded remotely updated file from the server",
                author: fullVersion.userId,
                timestamp: new Date(fullVersion.updatedDate)
            });
        }
    }

    private async processRemoteUpdateForNewDocument(
        remoteVersion: DocumentVersionWithoutContent
    ): Promise<void> {
        const oversizedEntry = this.getHistoryEntryForSkippedOversizedFile(
            remoteVersion.contentSize,
            remoteVersion.relativePath
        );
        if (oversizedEntry !== undefined) {
            this.history.addHistoryEntry(oversizedEntry);
            return;
        }

        const contentBytes =
            await this.syncService.getDocumentVersionContent({
                documentId: remoteVersion.documentId,
                vaultUpdateId: remoteVersion.vaultUpdateId
            });

        // A concurrent operation may have created the document already
        const existingDoc = this.queue.getDocumentByDocumentId(
            remoteVersion.documentId
        );
        if (existingDoc !== undefined) {
            this.logger.debug(
                `Document ${remoteVersion.relativePath} has already been created locally`
            );
            return;
        }

        const deconflictedPath = await this.operations.ensureClearPath(
            remoteVersion.relativePath
        );
        if (deconflictedPath !== undefined) {
            // The displaced file was moved to a deconflicted path.
            // Remove its document record so the offline scan treats
            // it as a new file rather than an existing document that
            // needs its path synced (which would create duplicates)
            this.queue.removeDocument(deconflictedPath);
        }

        const contentHash = await hash(contentBytes);
        this.queue.setDocument(remoteVersion.relativePath, {
            documentId: remoteVersion.documentId,
            parentVersionId: remoteVersion.vaultUpdateId,
            remoteHash: contentHash,
            remoteRelativePath: remoteVersion.relativePath
        });

        await this.operations.create(
            remoteVersion.relativePath,
            contentBytes
        );

        await this.updateCache(
            remoteVersion.vaultUpdateId,
            contentBytes,
            remoteVersion.relativePath
        );


        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.CREATE,
                relativePath: remoteVersion.relativePath
            },
            message:
                "Successfully downloaded remote file which hadn't existed locally",
            author: remoteVersion.userId,
            timestamp: new Date(remoteVersion.updatedDate)
        });
    }



    private async sendUpdate(
        record: DocumentRecord,
        relativePath: RelativePath,
        contentBytes: Uint8Array
    ): Promise<DocumentUpdateResponse> {
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

    private async handleMaybeMergingResponse({
        path,
        response,
        contentHash,
        originalContentBytes
    }: {
        path: RelativePath;
        response: DocumentUpdateResponse;
        contentHash: string;
        originalContentBytes: Uint8Array;
    }): Promise<void> {
        if (response.isDeleted) {
            // If the local file has been edited, re-create it as a new
            // document so local edits survive the remote delete
            if (await this.operations.exists(path)) {
                const localBytes = await this.operations.read(path);
                const localHash = await hash(localBytes);
                const record = this.queue.getSettledDocumentByPath(path);
                if (record !== undefined && localHash !== record.remoteHash) {
                    this.queue.removeDocument(path);
                    this.syncLocallyCreatedFile(path);
                    return;
                }
            }
            await this.operations.delete(path);
            this.queue.removeDocument(path);
            return;
        }

        let actualPath = path;

        // Server may have changed the path (e.g. first-rename-wins conflict)
        if (response.relativePath !== path) {
            actualPath = response.relativePath;
            const displacedPath = await this.operations.move(
                path,
                response.relativePath
            );
            if (displacedPath !== undefined) {
                const displacedRecord =
                    this.queue.getSettledDocumentByPath(displacedPath);
                if (displacedRecord !== undefined) {
                    const displacedBytes =
                        await this.operations.read(displacedPath);
                    const displacedHash = await hash(displacedBytes);
                    if (displacedHash !== displacedRecord.remoteHash) {
                        this.queue.enqueue({ type: SyncEventType.SyncLocal, path: displacedPath });
                    }
                }
            }
            // Remove old path entry; the new path will be set below
            this.queue.removeDocument(path);
        }

        if ("type" in response && response.type === "MergingUpdate") {
            const responseBytes = base64ToBytes(response.contentBase64);
            await this.operations.write(
                actualPath,
                originalContentBytes,
                responseBytes
            );

            // Re-read and re-hash after write (invariant #3)
            const afterWriteBytes = await this.operations.read(actualPath);
            const afterWriteHash = await hash(afterWriteBytes);

            this.queue.setDocument(actualPath, {
                documentId: response.documentId,
                parentVersionId: response.vaultUpdateId,
                remoteHash: afterWriteHash,
                remoteRelativePath: response.relativePath
            });

            // Cache the SERVER's content, not local (invariant #2)
            await this.updateCache(
                response.vaultUpdateId,
                responseBytes,
                actualPath
            );
        } else {
            // Fast-forward update: no merge needed
            this.queue.setDocument(actualPath, {
                documentId: response.documentId,
                parentVersionId: response.vaultUpdateId,
                remoteHash: contentHash,
                remoteRelativePath: response.relativePath
            });

            await this.updateCache(
                response.vaultUpdateId,
                originalContentBytes,
                actualPath
            );
        }
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

    private notifyRemainingOperationsChanged(): void {
        const currentCount = this.queue.size;
        if (this.previousRemainingOperationsCount !== currentCount) {
            this.previousRemainingOperationsCount = currentCount;
            this.onRemainingOperationsCountChanged.trigger(currentCount);
        }
    }
}
