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

export class Syncer {
    public readonly onRemainingOperationsCountChanged = new EventListeners<
        (remainingOperations: number) => unknown
    >();

    private readonly remoteDocumentsLock: Locks<DocumentId>;

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

        this.remoteDocumentsLock = new Locks<DocumentId>(this.logger);

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

    public async syncLocallyCreatedFile(
        relativePath: RelativePath,
        { forceMerge }: { forceMerge: boolean }
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

        const [promise, resolve, reject] = createPromise();
        this.logger.warn(`creating ${relativePath} locally`);

        const document = this.database.createNewPendingDocument(
            relativePath,
            promise
        );

        try {
            await this.syncQueue.add(async () =>
                this.unrestrictedSyncer.unrestrictedSyncLocallyCreatedOrUpdatedFile(
                    { document, forceMerge }
                )
            )

            this.logger.warn(`done creating ${relativePath} locally`);


            resolve();
        } catch (e) {
            reject(e);
        } finally {
            this.database.removeDocumentPromise(promise);
        }
    }

    public async syncLocallyDeletedFile(
        relativePath: RelativePath
    ): Promise<void> {
        if (
            this.database.getLatestDocumentByRelativePath(relativePath)
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

        const [promise, resolve, reject] = createPromise();

        const document = await this.database.getResolvedDocumentByRelativePath(
            relativePath,
            promise
        );

        try {
            await this.syncQueue.add(async () =>
                this.unrestrictedSyncer.unrestrictedSyncLocallyDeletedFile(document)
            );

            resolve();

            this.database.removeDocument(document);
        } catch (e) {
            reject(e);
        } finally {
            this.database.removeDocumentPromise(promise);
        }
    }

    public async syncLocallyUpdatedFile({
        oldPath,
        relativePath
    }: {
        oldPath?: RelativePath;
        relativePath: RelativePath;
    }): Promise<void> {
        if (oldPath !== undefined) {
            // We might have moved the document in the database before calling this method,
            // in that case, we mustn't move it again.
            if (
                this.database.getLatestDocumentByRelativePath(relativePath) ===
                undefined ||
                this.database.getLatestDocumentByRelativePath(relativePath)
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

        this.logger.warn(`sync doc ${JSON.stringify(document)} for path ${relativePath} (old path: ${oldPath}), len docs: ${document?.updates.length}`);

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

        const [promise, resolve, reject] = createPromise();

        document = await this.database.getResolvedDocumentByRelativePath(
            relativePath,
            promise
        );
        this.logger.warn(`updating ${document.relativePath} locally`);

        try {
            await this.syncQueue.add(async () =>
                this.unrestrictedSyncer.unrestrictedSyncLocallyCreatedOrUpdatedFile({
                    oldPath,
                    document: document!
                })
            );

            resolve();
        } catch (e) {
            reject(e);
        } finally {
            this.database.removeDocumentPromise(promise);
        }
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
        this.remoteDocumentsLock.reset();
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
        let document = this.database.getDocumentByDocumentId(
            remoteVersion.documentId
        );

        this.logger.warn(`${remoteVersion.documentId} got remote update  ${JSON.stringify(remoteVersion)}`);

        if (document === undefined) {
            this.logger.warn(`${remoteVersion.documentId} but document doesn't exist`)


            return this.remoteDocumentsLock.withLock(
                // Avoid the same documents getting created in parallel multiple times through fetching multiple updates of the same
                // new remote document concurrently.
                // There might be multiple tasks waiting for the lock
                remoteVersion.documentId,
                async () => {

                    // We have to wait for any ongoing creates sent for this file to finish,
                    // This is to avoid fetching one's own creates before the corresponding local create has finished syncing. This is a concern because
                    // documents being created don't yet have a document id in the local database and we could be notified of the remote create 
                    // before the local create has finished syncing, so we can't just ignore the update based on the local DB content as we 
                    // can't find the corresponding document yet. 
                    if (document?.metadata === undefined) {
                        await this.unrestrictedSyncer.fileCreationLock.waitForLockWithoutAcquiringLock(remoteVersion.relativePath);
                    }

                    document = this.database.getDocumentByDocumentId(
                        remoteVersion.documentId
                    );

                    this.logger.warn(`${remoteVersion.documentId} rechecking, document is now ${JSON.stringify(document)}`)

                    // We're the first one to get the lock, so we have to create the document in `unrestrictedSyncRemotelyUpdatedFile`
                    if (document === undefined) {
                        this.logger.warn(`${remoteVersion.documentId} document is undefined, creating new document`)
                        await this.syncQueue.add(async () =>
                            this.unrestrictedSyncer.unrestrictedSyncRemotelyUpdatedFile(
                                remoteVersion
                            )
                        );
                    } else {
                        const [promise, resolve, reject] =
                            createPromise();

                        document =
                            await this.database.getResolvedDocumentByRelativePath(
                                document.relativePath,
                                promise
                            );

                        try {
                            await this.syncQueue.add(async () =>
                                this.unrestrictedSyncer.unrestrictedSyncRemotelyUpdatedFile(
                                    remoteVersion,
                                    document
                                )
                            );

                            resolve();
                        } catch (e) {
                            reject(e);
                        } finally {
                            this.database.removeDocumentPromise(
                                promise
                            );
                        }
                    }

                    this.database.addSeenUpdateId(
                        remoteVersion.vaultUpdateId
                    );
                }
            )
        } else {
            this.logger.warn(`${remoteVersion.documentId} and document exists (path: ${JSON.stringify(document)})`);
        }

        // We're either the first one to get the lock, so we have to create the document in `unrestrictedSyncRemotelyUpdatedFile`
        const [promise, resolve, reject] = createPromise();

        document = await this.database.getResolvedDocumentByRelativePath(
            document.relativePath,
            promise
        );

        try {
            await this.syncQueue.add(async () =>
                this.unrestrictedSyncer.unrestrictedSyncRemotelyUpdatedFile(
                    remoteVersion,
                    document
                )
            );

            resolve();
        } catch (e) {
            reject(e);
        } finally {
            this.database.removeDocumentPromise(promise);
        }

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

        type Instruction = { "type": "update" | "create", relativePath: string, oldPath?: string };
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


        await awaitAll(instructions.map(async (instruction) => {
            if (instruction === undefined) {
                return;
            }

            if (instruction.type === "update") {
                // We're outside of the pqueue, so we need to call the public wrapper
                return await this.syncLocallyUpdatedFile({
                    oldPath: instruction.oldPath,
                    relativePath: instruction.relativePath
                });
            }
        }));

        // we have to ensure the deletes & updates have finished before starting creates,
        // otherwise the server might return an existing document (that we're about to delete)
        // instead of actually creating a new one
        await awaitAll(instructions.map(async (instruction) => {
            if (instruction === undefined) {
                return;
            }

            if (instruction.type === "create") {
                // We're outside of the pqueue, so we need to call the public wrapper
                return await this.syncLocallyCreatedFile(instruction.relativePath, { forceMerge: true });
            }
        }));


    }
}
