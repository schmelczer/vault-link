import type {
    Database,
    DocumentId,
    DocumentRecord,
    RelativePath
} from "../persistence/database";
import type { Logger } from "../tracing/logger";
import PQueue from "p-queue";
import { hash } from "../utils/hash";
import type { Settings } from "../persistence/settings";
import type { FileOperations } from "../file-operations/file-operations";
import { findMatchingFile } from "../utils/find-matching-file";
import type { UnrestrictedSyncer } from "./unrestricted-syncer";
import { createPromise } from "../utils/create-promise";
import { SyncResetError } from "../errors/sync-reset-error";
import { Locks } from "../utils/data-structures/locks";
import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";
import type { WebSocketVaultUpdate } from "../services/types/WebSocketVaultUpdate";
import type { WebSocketManager } from "../services/websocket-manager";
import type { WebSocketClientMessage } from "../services/types/WebSocketClientMessage";
import { awaitAll } from "../utils/await-all";
import { EventListeners } from "../utils/data-structures/event-listeners";

export const __debug_locks: Locks<any>[] = []; // Used only for debugging timeouts

export class Syncer {
    public readonly onRemainingOperationsCountChanged = new EventListeners<
        (remainingOperations: number) => unknown
    >();

    public readonly updatedDocumentsByPathAndKeysLock: Locks<DocumentId | RelativePath>;

    // FIFO to limit the number of concurrent sync operations
    private readonly syncQueue: PQueue;

    private _isFirstSyncComplete = false;
    private runningScheduleSyncForOfflineChanges: Promise<void> | undefined;
    private previousRemainingOperationsCount = 0;

    public constructor(
        private readonly deviceId: string,
        private readonly logger: Logger,
        private readonly database: Database,
        private readonly settings: Settings,
        private readonly webSocketManager: WebSocketManager,
        private readonly operations: FileOperations,
        private readonly unrestrictedSyncer: UnrestrictedSyncer
    ) {
        this.syncQueue = new PQueue({
            concurrency: settings.getSettings().syncConcurrency
        });

        this.updatedDocumentsByPathAndKeysLock = new Locks<DocumentId>(this.logger);
        __debug_locks.push(this.updatedDocumentsByPathAndKeysLock); // Used only for debugging timeouts

        settings.onSettingsChanged.add((newSettings, oldSettings) => {
            if (newSettings.syncConcurrency !== oldSettings.syncConcurrency) {
                this.syncQueue.concurrency = newSettings.syncConcurrency;
            }
        });

        this.syncQueue.on("active", () => {
            if (this.previousRemainingOperationsCount !== this.syncQueue.size) {
                this.previousRemainingOperationsCount = this.syncQueue.size;
                this.onRemainingOperationsCountChanged.trigger(
                    this.syncQueue.size
                );
            }
        });

        this.webSocketManager.onWebSocketStatusChanged.add((isConnected) => {
            if (isConnected) {
                // The JS WebSocket API doesn't support setting headers, so we have to send the token as a message
                this.sendHandshakeMessage();
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
        return this.updatedDocumentsByPathAndKeysLock.isLocked(relativePath);
    }

    public async syncLocallyCreatedFile(
        relativePath: RelativePath
    ): Promise<void> {
        if (
            this.database.getLatestDocumentByRelativePath(relativePath)
                ?.isDeleted === false
        ) {
            // This is likely a consequence of us creating a file because of a remote update
            // which triggered a local create, so we don't need to do anything here.
            this.logger.debug(
                `Document ${relativePath} already exists in the database, skipping`
            );
            return;
        }

        const document = this.database.createNewPendingDocument(
            relativePath
        );

        await this.enqueueSyncOperation(async () =>
            this.unrestrictedSyncer.unrestrictedSyncLocallyCreatedOrUpdatedFile(
                {
                    document
                }
            ), [relativePath]
        );
    }

    public async syncLocallyDeletedFile(
        relativePath: RelativePath
    ): Promise<void> {
        const document = this.database.getLatestDocumentByRelativePath(relativePath);


        if (
            document
                ?.isDeleted === true
        ) {
            // This is must be a consequence of us deleting a file because of a remote update
            // which triggered a local delete, so we don't need to do anything here.
            this.logger.debug(
                `Document ${relativePath} has already been marked as deleted, skipping`
            );
            return;
        }

        // We have to have a record of the delete in case there's an in-flight update for the same
        // document which finishes after the delete has succeeded and would introduce a phantom metadata record.
        this.database.delete(relativePath);



        await this.enqueueSyncOperation(async () => {
            const document = this.database.getLatestDocumentByRelativePath(relativePath);

            if (document === undefined) {
                this.logger.debug(
                    `Cannot find document ${relativePath} in the database, must have been deleted already, skipping`
                );
                return;
            }

            await this.unrestrictedSyncer.unrestrictedSyncLocallyDeletedFile(
                document
            );

            this.database.removeDocument(document);
        }, [document?.metadata?.documentId, relativePath]
        );
    }

    public async syncLocallyUpdatedFile({
        oldPath,
        relativePath
    }: {
        oldPath?: RelativePath;
        relativePath: RelativePath;
    }): Promise<void> {
        const documentAtNewPath = this.database.getLatestDocumentByRelativePath(
            relativePath
        );

        if (oldPath !== undefined) {
            // We might have moved the document in the database before calling this method,
            // in that case, we mustn't move it again.
            if (
                documentAtNewPath ===
                undefined ||
                documentAtNewPath
                    ?.isDeleted === true
            ) {
                if (oldPath === relativePath) {
                    throw new Error(
                        `Old path and new path are the same: ${oldPath}`
                    );
                }

                this.database.move(oldPath, relativePath);
            }
        }

        let document =
            this.database.getLatestDocumentByRelativePath(relativePath);

        if (
            oldPath !== undefined &&
            document?.metadata?.remoteRelativePath === relativePath
        ) {
            this.logger.debug(
                `Document ${relativePath} has been moved as a result of a remote update, skipping sync`
            );
            return;
        }

        // must have been removed after a successful delete
        if (document === undefined) {
            this.logger.debug(
                `Cannot find document ${relativePath} in the database, skipping`
            );
            return;
        }

        if (document.isDeleted) {
            this.logger.debug(
                `Document ${relativePath} has been deleted locally, skipping`
            );
            return;
        }


        await this.enqueueSyncOperation(async () =>
            this.unrestrictedSyncer.unrestrictedSyncLocallyCreatedOrUpdatedFile(
                {
                    oldPath,
                    document
                }
            ), [document.metadata?.documentId, relativePath, oldPath]
        );


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
        await this.syncQueue.onIdle(); // Wait for queue to be empty and running tasks to finish
    }

    public async syncRemotelyUpdatedFile(
        message: WebSocketVaultUpdate
    ): Promise<void> {
        try {
            await this.scheduleSyncForOfflineChanges();

            const handlerPromise = awaitAll(
                message.documents.map(async (document) =>
                    this.internalSyncRemotelyUpdatedFile(document)
                )
            );

            await handlerPromise;

            if (message.isInitialSync && message.documents.length > 0) {
                this.database.setLastSeenUpdateId(
                    message.documents
                        .map((document) => document.vaultUpdateId)
                        .reduce((a, b) => Math.max(a, b))
                );
            }

            this._isFirstSyncComplete = true;
        } catch (e) {
            this.logger.error(`Failed to sync remotely updated file: ${e}`);
        }
    }

    public reset(): void {
        this._isFirstSyncComplete = false;
        this.syncQueue.clear();
        this.updatedDocumentsByPathAndKeysLock.reset();
        this.runningScheduleSyncForOfflineChanges = undefined;
    }

    private sendHandshakeMessage(): void {
        const message: WebSocketClientMessage = {
            type: "handshake",
            deviceId: this.deviceId,
            token: this.settings.getSettings().token,
            lastSeenVaultUpdateId: this.database.getLastSeenUpdateId()
        };
        this.webSocketManager.sendHandshakeMessage(message);
    }

    private async internalSyncRemotelyUpdatedFile(
        remoteVersion: DocumentVersionWithoutContent
    ): Promise<void> {
        const document = this.database.getDocumentByDocumentId(
            remoteVersion.documentId
        );
        this.enqueueSyncOperation(async () =>
            await this.syncQueue.add(async () =>
                this.unrestrictedSyncer.unrestrictedSyncRemotelyUpdatedFile(
                    remoteVersion,
                    document
                )
            ), [document?.relativePath, remoteVersion.relativePath, remoteVersion.documentId]
        );

        this.database.addSeenUpdateId(remoteVersion.vaultUpdateId);
    }

    private async internalScheduleSyncForOfflineChanges(): Promise<void> {
        const allLocalFiles = await this.operations.listFilesRecursively();
        this.logger.info(
            `Scheduling sync for ${allLocalFiles.length} local files`
        );

        let locallyPossiblyDeletedFiles: DocumentRecord[] = [];

        for (const document of this.database.resolvedDocuments) {
            if (
                !document.isDeleted &&
                !(await this.operations.exists(document.relativePath))
            ) {
                locallyPossiblyDeletedFiles.push(document);
            }
        }

        interface Instruction {
            type: "update" | "create";
            relativePath: string;
            oldPath?: string;
        }
        const instructions: (Instruction | undefined)[] = await awaitAll(
            allLocalFiles.map(async (relativePath) => {
                if (
                    this.database.getLatestDocumentByRelativePath(relativePath)
                        ?.metadata !== undefined
                ) {
                    this.logger.debug(
                        `Document ${relativePath} might have been updated locally, scheduling sync to validate and update it`
                    );

                    return { type: "update", relativePath } as Instruction;
                }

                // Perhaps the file has been moved; let's check by looking at the deleted files
                const contentHash = await this.syncQueue.add(async () => {
                    try {
                        const contentBytes =
                            await this.operations.read(relativePath); // this can throw FileNotFoundError
                        return hash(contentBytes);
                    } catch (e) {
                        if (
                            e instanceof Error &&
                            e.name === "FileNotFoundError"
                        ) {
                            return undefined;
                        }
                        throw e;
                    }
                });

                if (contentHash == undefined) {
                    // The file was deleted before we had a chance to read it, no need to sync it here
                    return;
                }

                const originalFile = findMatchingFile(
                    contentHash,
                    locallyPossiblyDeletedFiles
                );
                if (originalFile !== undefined) {
                    // `originalFile` hasn't been deleted but it got moved instead
                    /* eslint-disable no-restricted-syntax -- Comparing by property, not direct equality */
                    locallyPossiblyDeletedFiles =
                        locallyPossiblyDeletedFiles.filter(
                            (item) =>
                                item.relativePath !== originalFile.relativePath
                        );
                    /* eslint-enable no-restricted-syntax */

                    this.logger.debug(
                        `Document '${originalFile.relativePath}' was not found under its current path in the database but was found under a different path (${relativePath}), scheduling sync to move it`
                    );

                    return {
                        type: "update",
                        oldPath: originalFile.relativePath,
                        relativePath
                    } as Instruction;
                }

                this.logger.debug(
                    `Document ${relativePath} not found in database, scheduling sync to create it`
                );

                return {
                    type: "create",
                    relativePath
                } as Instruction;
            })
        );

        // this has to happen strictly after the previous awaitAll, as that one
        // might have removed some of the documents from the list
        await awaitAll(
            locallyPossiblyDeletedFiles.map(async ({ relativePath }) => {
                this.logger.debug(
                    `Document ${relativePath} has been deleted locally, scheduling sync to delete it`
                );

                // We're outside of the pqueue, so we need to call the public wrapper
                return this.syncLocallyDeletedFile(relativePath);
            })
        );

        await awaitAll(
            instructions.map(async (instruction) => {
                if (instruction === undefined) {
                    return;
                }

                if (instruction.type === "update") {
                    // We're outside of the pqueue, so we need to call the public wrapper
                    await this.syncLocallyUpdatedFile({
                        oldPath: instruction.oldPath,
                        relativePath: instruction.relativePath
                    });
                    return;
                }
            })
        );

        // we have to ensure the deletes & updates have finished before starting creates,
        // otherwise the server might return an existing document (that we're about to delete)
        // instead of actually creating a new one
        await awaitAll(
            instructions.map(async (instruction) => {
                if (instruction === undefined) {
                    return;
                }

                if (instruction.type === "create") {
                    // We're outside of the pqueue, so we need to call the public wrapper
                    await this.syncLocallyCreatedFile(instruction.relativePath);
                    return;
                }
            })
        );
    }

    private async enqueueSyncOperation<T>(
        operation: () => Promise<T>,
        keys: Array<DocumentId | RelativePath | undefined | null>
    ): Promise<T> {
        return this.updatedDocumentsByPathAndKeysLock.withLock(keys.filter(k => k !== undefined && k !== null), async () =>
            this.syncQueue.add(operation)
        );
    }
}
