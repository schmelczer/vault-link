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
import type { WebSocketVaultPathChange } from "../services/types/WebSocketVaultPathChange";
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
                // Don't null the reference synchronously — if the scan is
                // still in flight, the next reconnect would spawn a second
                // concurrent scan racing on the same queue. Defer the
                // clear until the in-flight task actually resolves, so a
                // fresh scan can only start once the prior one is done.
                const current = this.runningScheduleSyncForOfflineChanges;
                if (current === undefined) return;
                current
                    .catch(() => {
                        /* swallow — internal error already logged */
                    })
                    .finally(() => {
                        if (
                            this.runningScheduleSyncForOfflineChanges ===
                            current
                        ) {
                            this.runningScheduleSyncForOfflineChanges =
                                undefined;
                        }
                    });
            }
        });
        this.webSocketManager.onRemoteVaultUpdateReceived.add(
            this.syncRemotelyUpdatedFile.bind(this)
        );
        this.webSocketManager.onRemotePathChangeReceived.add(
            this.syncRemotelyChangedPath.bind(this)
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

    // A PathChange notifies us that a document now lives at a new server-
    // canonical path. It's delivered to every client (origin included)
    // because the create/update HTTP response no longer carries the path,
    // so the only way the origin learns about dedupe or first-rename-wins
    // is via this event.
    //
    // Algorithmic assumptions:
    //   (1) Per-vault broadcast ordering is preserved by the server, so if
    //       the same write produced a `VaultUpdate` (content change) and a
    //       `PathChange` (path change), the `VaultUpdate` is handled first
    //       — that's what lets us skip advancing `parentVersionId` here
    //       without risking a stuck "already up-to-date" check later.
    //   (2) On a lag-induced disconnect (`broadcast::error::Lagged`) the
    //       server disconnects the client for a full resync, so out-of-
    //       order delivery across a reconnect boundary can't leave us with
    //       a stale PathChange overwriting a newer one.
    public async syncRemotelyChangedPath(
        pathChange: WebSocketVaultPathChange
    ): Promise<void> {
        // Serialize onto the drain chain so this handler can't race against
        // an in-flight `processSyncRemote` / `processSyncLocal` etc. that
        // captured the old path before our move.
        try {
            await this.chainOntoDrain(async () => {
                const existing = this.queue.getDocumentByDocumentId(
                    pathChange.documentId
                );
                if (existing === undefined) {
                    throw new Error(
                        `Received path change for unknown document ${pathChange.documentId}`
                    );
                }

                const { path: currentPath, record } = existing;
                const newPath = pathChange.relativePath;

                if (currentPath !== newPath) {
                    await this.operations.move(currentPath, newPath);

                    this.history.addHistoryEntry({
                        status: SyncStatus.SUCCESS,
                        details: {
                            type: SyncType.MOVE,
                            relativePath: newPath,
                            movedFrom: currentPath
                        },
                        message: "Applied remote path change",
                        author: pathChange.userId,
                        timestamp: new Date(pathChange.updatedDate)
                    });
                }

                // `operations.move` updates the queue's path index, but
                // doesn't touch `remoteRelativePath`. Refresh it so offline
                // change detection compares against the server's path.
                // parentVersionId intentionally stays at its prior value:
                // if the write also changed content, the corresponding
                // VaultUpdate handles that; advancing it here would make us
                // skip fetching content we don't yet have.
                this.queue.setDocument(newPath, {
                    ...record,
                    remoteRelativePath: newPath
                });
            });
        } catch (e) {
            if (e instanceof SyncResetError) {
                this.logger.info(
                    "Failed to apply remote path change due to a reset"
                );
                return;
            }
            this.logger.error(`Failed to apply remote path change: ${e}`);
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
        // Offline scan wipes the event queue via `queue.clear()` and then
        // rebuilds events from disk. That MUST NOT race against an
        // in-flight drain iteration that may already hold a reference to
        // a freshly-cleared event — chain onto the drain so the scan runs
        // between drain ticks, never concurrently.
        await this.chainOntoDrain(async () => {
            await scheduleOfflineChanges(
                { logger: this.logger, operations: this.operations, queue: this.queue },
                (path) => { this.syncLocallyCreatedFile(path); },
                (args) => { this.syncLocallyUpdatedFile(args); },
                (path) => { this.syncLocallyDeletedFile(path); },
            );
        });

        await this.scheduleDrain();
    }



    private ensureDraining(): void {
        void this.chainOntoDrain(async () => this.drain());
    }

    /**
     * Serialize a unit of work onto the same promise chain the drain
     * uses. This is how direct WebSocket handlers (`syncRemotelyChangedPath`,
     * offline-scan) avoid racing against the drain loop: every mutator of
     * the queue / disk goes through this single chain, in order of arrival.
     */
    private async chainOntoDrain<T>(work: () => Promise<T>): Promise<T> {
        const chained = (this.draining ?? Promise.resolve()).then(
            async () => work()
        );
        // We track the chain via `this.draining` so later work chains onto
        // the latest link. Swallow the result-typed value for storage; the
        // caller still awaits the true result via `chained`.
        this.draining = chained.then(
            () => undefined,
            () => undefined
        );
        return chained;
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
                // The event was already shifted off the queue before
                // `processEvent` ran; if it was a Create, its resolver
                // promise would otherwise hang forever, blocking any
                // queued Delete / SyncLocal that `await`s it.
                if (event.type === SyncEventType.Create) {
                    event.resolvers?.promise.catch(() => {
                        /* suppressed */
                    });
                    event.resolvers?.reject(
                        new Error(
                            `Create was cancelled — server rejected the request (${e.message})`
                        )
                    );
                }
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
            lastSeenVaultUpdateId: this.queue.lastSeenUpdateId,
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
            originalContentBytes: contentBytes,
            createEvent: event
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

            // Path reconciliation fallback for the reconnect case.
            //
            // In steady-state streaming, server-initiated renames arrive as
            // dedicated `PathChange` WebSocket events and are handled by
            // `syncRemotelyChangedPath`. But the reconnect catch-up path
            // (`get_unseen_documents` → `VaultUpdate(is_initial_sync=…)`)
            // replays *versions* from the DB — `PathChange` is emission-
            // only and not replayed. Without this branch, a pure rename
            // that happened while we were disconnected would leave our
            // local file stuck at its old path forever.
            //
            // Only apply the server's path when the record's
            // `remoteRelativePath` still matches `currentPath` — that means
            // we haven't locally renamed since we last heard from the
            // server, so the server's path is authoritative. Any local
            // rename in flight keeps priority (it'll be resolved by the
            // server on its next write).
            let targetPath = currentPath;
            if (
                fullVersion.relativePath !== currentPath &&
                record.remoteRelativePath === currentPath
            ) {
                await this.operations.move(currentPath, fullVersion.relativePath);
                targetPath = fullVersion.relativePath;
            }

            await this.operations.write(
                targetPath,
                contentBytes,
                responseBytes
            );

            // Re-read and re-hash after write (the 3-way merge may produce different content)
            const afterWriteBytes = await this.operations.read(targetPath);
            const afterWriteHash = await hash(afterWriteBytes);

            if (targetPath !== currentPath) {
                this.queue.removeDocument(currentPath);
            }
            this.queue.setDocument(targetPath, {
                documentId: fullVersion.documentId,
                parentVersionId: fullVersion.vaultUpdateId,
                remoteHash: afterWriteHash,
                remoteRelativePath: fullVersion.relativePath
            });

            await this.updateCache(
                fullVersion.vaultUpdateId,
                responseBytes,
                targetPath
            );

            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details:
                    targetPath !== currentPath
                        ? {
                              type: SyncType.MOVE,
                              relativePath: targetPath,
                              movedFrom: currentPath
                          }
                        : {
                              type: SyncType.UPDATE,
                              relativePath: targetPath
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

        // Special case: local has an *unsynced* new file at the same path.
        // The client must cancel the outgoing Create and merge the two files
        // instead of displacing the local one to a conflict path — those
        // files are semantically "the same user-intended document" that two
        // devices created concurrently, so we want to preserve both sides'
        // edits, not shelve one aside.
        if (this.queue.hasPendingCreateAt(remoteVersion.relativePath)) {
            await this.mergeUnsyncedLocalWithRemoteCreate(
                remoteVersion,
                contentBytes
            );
            return;
        }

        await this.operations.ensureClearPath(remoteVersion.relativePath);

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

    // A remote create landed at a path where we have an unsynced local
    // create. How we resolve depends on whether both sides are mergeable
    // text: text gets an in-place union merge and one follow-up update;
    // binary falls through to displacement so *both* files survive.
    private async mergeUnsyncedLocalWithRemoteCreate(
        remoteVersion: DocumentVersionWithoutContent,
        remoteContent: Uint8Array
    ): Promise<void> {
        const path = remoteVersion.relativePath;
        const localContent = await this.operations.read(path);

        const canMergeText =
            isFileTypeMergable(
                path,
                (await this.serverConfig.getConfig()).mergeableFileExtensions
            ) &&
            !isBinary(localContent) &&
            !isBinary(remoteContent);

        if (!canMergeText) {
            // Binary (or non-mergeable) concurrent creates: leave the local
            // Create in the queue and let the default displacement flow
            // take over (local bytes are moved to `conflict-<uuid>-…` by
            // `ensureClearPath`, remote bytes take `path`). When the Create
            // eventually fires it reads the remote content at `path` — not
            // what we want — so cancel *just* the Create event and
            // re-enqueue a fresh one sourced from the displaced path, so
            // the server receives the user's original bytes and dedupes
            // the path on its own.
            this.queue.cancelPendingCreate(path);

            // `ensureClearPath` may return `undefined` if the file was
            // deleted between `read(path)` above and this call (a TOCTOU
            // race with a concurrent filesystem delete). That's fine:
            // nothing to displace means no local bytes to preserve, and
            // we just proceed with the remote content.
            const conflictPath =
                await this.operations.ensureClearPath(path);

            this.queue.setDocument(path, {
                documentId: remoteVersion.documentId,
                parentVersionId: remoteVersion.vaultUpdateId,
                remoteHash: await hash(remoteContent),
                remoteRelativePath: path
            });
            await this.operations.create(path, remoteContent);
            await this.updateCache(
                remoteVersion.vaultUpdateId,
                remoteContent,
                path
            );

            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: {
                    type: SyncType.CREATE,
                    relativePath: path
                },
                message:
                    conflictPath !== undefined
                        ? `Adopted remote create at ${path}; unsynced local bytes preserved at ${conflictPath} for manual recovery`
                        : `Adopted remote create at ${path}; local file had already been removed`,
                author: remoteVersion.userId,
                timestamp: new Date(remoteVersion.updatedDate)
            });
            return;
        }

        // Mergeable text: union-merge with empty parent (every byte in
        // either side is treated as an insertion), overwrite disk, and
        // push the merged result to the server if it diverged from the
        // remote copy. Cancelling the Create and re-emitting as a
        // SyncLocal update lets the existing merge-response pipeline
        // handle parentVersionId/content reconciliation end-to-end.
        this.queue.cancelPendingCreate(path);

        const mergedContent = new TextEncoder().encode(
            reconcile(
                "",
                new TextDecoder().decode(localContent),
                new TextDecoder().decode(remoteContent)
            ).text
        );

        // Adopt the remote document's identity locally *before* touching
        // disk so an interleaved event can't mistake the file for a fresh
        // create again. `remoteHash` is deliberately the server's content
        // hash (not the merged one) so the SyncLocal below sees a real
        // diff and actually uploads the merge.
        const remoteHash = await hash(remoteContent);
        this.queue.setDocument(path, {
            documentId: remoteVersion.documentId,
            parentVersionId: remoteVersion.vaultUpdateId,
            remoteHash,
            remoteRelativePath: path
        });

        // Overwrite disk with the merged result. We pass `localContent` as
        // the "expected" content so `operations.write`'s internal 3-way
        // merge is a no-op (expected == disk ⇒ apply `new` verbatim).
        await this.operations.write(path, localContent, mergedContent);

        await this.updateCache(
            remoteVersion.vaultUpdateId,
            remoteContent,
            path
        );

        const mergedHash = await hash(mergedContent);
        if (mergedHash !== remoteHash) {
            this.syncLocallyUpdatedFile({ relativePath: path });
        }

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.CREATE,
                relativePath: path
            },
            message: "Merged unsynced local file with concurrent remote create",
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
        originalContentBytes,
        createEvent
    }: {
        path: RelativePath;
        response: DocumentUpdateResponse;
        contentHash: string;
        originalContentBytes: Uint8Array;
        // When processing a Create, pass the originating event so its
        // `resolvers` promise can be fulfilled (or rejected, on a deleted
        // response). Dependent SyncLocal/Delete events are chained through
        // that promise and would otherwise `await` forever.
        createEvent?: Extract<SyncEvent, { type: SyncEventType.Create }>;
    }): Promise<void> {
        if (response.isDeleted) {
            // A Create that the server returned as already-deleted means
            // nothing we can sync — reject the waiting promise so chained
            // Delete / SyncLocal events skip themselves instead of hanging.
            if (createEvent?.resolvers !== undefined) {
                createEvent.resolvers.promise.catch(() => {
                    /* suppressed — consumer may not be listening */
                });
                createEvent.resolvers.reject(
                    new Error(
                        "Create was cancelled — server reported the document as deleted"
                    )
                );
            }

            // Capture the documentId of the record we *believe* is at
            // `path` now. If a concurrent `syncRemotelyChangedPath` moves
            // this document between our exists-check and our read, the
            // record at `path` after those awaits may belong to a
            // DIFFERENT document. Guard against that.
            const originalRecord =
                this.queue.getSettledDocumentByPath(path);
            const originalDocumentId = originalRecord?.documentId;

            // If the local file has been edited, re-create it as a new
            // document so local edits survive the remote delete — but only
            // if nothing else is already queuing a Create for this path, to
            // avoid doubling up when offline-change detection races with us.
            if (await this.operations.exists(path)) {
                const localBytes = await this.operations.read(path);
                const localHash = await hash(localBytes);
                const currentRecord =
                    this.queue.getSettledDocumentByPath(path);
                // Re-verify the record's identity hasn't shifted under us.
                if (
                    currentRecord !== undefined &&
                    currentRecord.documentId === originalDocumentId &&
                    localHash !== currentRecord.remoteHash &&
                    !this.queue.hasPendingCreateAt(path)
                ) {
                    this.queue.removeDocument(path);
                    this.syncLocallyCreatedFile(path);
                    return;
                }
            }
            // Only delete on disk if the record at `path` is still the one
            // we expected — if a PathChange moved another doc here, we
            // shouldn't delete its file.
            const finalRecord = this.queue.getSettledDocumentByPath(path);
            if (
                finalRecord === undefined ||
                finalRecord.documentId === originalDocumentId
            ) {
                await this.operations.delete(path);
                this.queue.removeDocument(path);
            }
            return;
        }

        // The response carries content only — path reconciliation is the
        // sole responsibility of the `PathChange` WebSocket event, which
        // fires independently for renames/dedupes. We therefore always
        // record the current local `path` here; an in-flight `PathChange`
        // will move the file and fix `remoteRelativePath` if the server
        // placed the document somewhere else.
        const existingRecord = this.queue.getSettledDocumentByPath(path);
        const remoteRelativePath = existingRecord?.remoteRelativePath ?? path;

        let record: DocumentRecord;
        if ("type" in response && response.type === "MergingUpdate") {
            const responseBytes = base64ToBytes(response.contentBase64);
            await this.operations.write(
                path,
                originalContentBytes,
                responseBytes
            );

            // Re-read and re-hash after write (invariant #3)
            const afterWriteBytes = await this.operations.read(path);
            const afterWriteHash = await hash(afterWriteBytes);

            record = {
                documentId: response.documentId,
                parentVersionId: response.vaultUpdateId,
                remoteHash: afterWriteHash,
                remoteRelativePath
            };

            // Cache the SERVER's content, not local (invariant #2)
            await this.updateCache(
                response.vaultUpdateId,
                responseBytes,
                path
            );
        } else {
            // Fast-forward update: no merge needed
            record = {
                documentId: response.documentId,
                parentVersionId: response.vaultUpdateId,
                remoteHash: contentHash,
                remoteRelativePath
            };

            await this.updateCache(
                response.vaultUpdateId,
                originalContentBytes,
                path
            );
        }

        // For a Create, fulfill the resolver promise and replace any
        // `documentId: Promise<...>` references in queued Delete/SyncLocal
        // events with the now-known string id. For everything else a plain
        // `setDocument` is enough — the record's identity was already
        // resolved when the Create originally settled.
        if (createEvent !== undefined) {
            this.queue.resolveCreate(createEvent, record);
        } else {
            this.queue.setDocument(path, record);
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
