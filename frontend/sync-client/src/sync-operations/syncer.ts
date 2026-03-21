import type { Logger } from "../tracing/logger";
import type { Settings } from "../persistence/settings";
import type { FileOperations } from "../file-operations/file-operations";
import type { WebSocketVaultUpdate } from "../services/types/WebSocketVaultUpdate";
import type { WebSocketManager } from "../services/websocket-manager";
import type { WebSocketClientMessage } from "../services/types/WebSocketClientMessage";
import type { RelativePath } from "../persistence/database";
import type { VirtualFilesystem } from "../persistence/vfs";
import type { CoalescedAction } from "./sync-events";
import type { SyncDeps } from "./sync-actions";
import { SyncEventQueue } from "./sync-event-queue";
import {
    executeSyncCreate,
    executeSyncUpdate,
    executeSyncUpdateFull,
    executeSyncDelete,
    executeRemoteUpdate
} from "./sync-actions";
import { SyncResetError } from "../errors/sync-reset-error";
import { hash } from "../utils/hash";
import type { EventListeners } from "../utils/data-structures/event-listeners";

export class Syncer {
    public readonly onRemainingOperationsCountChanged: EventListeners<
        (remainingOperations: number) => unknown
    >;

    private _isFirstSyncComplete = false;
    private runningReconciliation: Promise<void> | undefined;
    private readonly eventUnsubscribers: (() => void)[] = [];
    private readonly queue: SyncEventQueue;

    public constructor(
        private readonly deviceId: string,
        private readonly logger: Logger,
        private readonly vfs: VirtualFilesystem,
        private readonly settings: Settings,
        private readonly webSocketManager: WebSocketManager,
        private readonly operations: FileOperations,
        private readonly deps: SyncDeps
    ) {
        this.queue = new SyncEventQueue(this.logger, this.vfs);
        this.queue.setExecutor(this.executeAction.bind(this));

        this.onRemainingOperationsCountChanged =
            this.queue.onRemainingOperationsCountChanged;

        this.eventUnsubscribers.push(
            this.webSocketManager.onWebSocketStatusChanged.add(
                (isConnected) => {
                    if (isConnected) {
                        this.sendHandshakeMessage();
                        this.queue.clearResetting();
                        void this.scheduleSyncForOfflineChanges();
                    } else {
                        this.reset();
                    }
                }
            )
        );

        this.eventUnsubscribers.push(
            this.webSocketManager.onRemoteVaultUpdateReceived.add(
                async (message: WebSocketVaultUpdate) => {
                    // Ensure offline reconciliation is running so that
                    // local changes are queued before remote updates
                    try {
                        await this.scheduleSyncForOfflineChanges();
                    } catch (e) {
                        if (e instanceof SyncResetError) {
                            this.logger.info(
                                "Sync reset during remote update processing"
                            );
                            return;
                        }
                        this.logger.error(
                            `Failed to sync remotely updated file: ${e}`
                        );
                    }

                    for (const doc of message.documents) {
                        this.queue.enqueue(
                            doc.isDeleted
                                ? { type: "remote-delete", version: doc }
                                : { type: "remote-update", version: doc }
                        );
                    }
                    // Do NOT advance the lastSeenUpdateId watermark here.
                    // Individual executeAction calls advance it after success
                    // via vfs.addSeenUpdateId inside the sync-actions functions.

                    this._isFirstSyncComplete = true;
                }
            )
        );
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    public get isFirstSyncComplete(): boolean {
        return this._isFirstSyncComplete;
    }

    public hasPendingOperationsForDocument(relativePath: string): boolean {
        return this.queue.hasPendingEventsFor(relativePath);
    }

    public hasOutstandingWork(): boolean {
        return (
            this.queue.hasOutstandingWork() ||
            this.runningReconciliation !== undefined
        );
    }

    public async syncLocallyCreatedFile(
        relativePath: RelativePath
    ): Promise<void> {
        this.queue.enqueue({ type: "local-create", path: relativePath });
    }

    public async syncLocallyDeletedFile(
        relativePath: RelativePath
    ): Promise<void> {
        this.queue.enqueue({ type: "local-delete", path: relativePath });
    }

    public async syncLocallyUpdatedFile({
        oldPath,
        relativePath
    }: {
        oldPath?: RelativePath;
        relativePath: RelativePath;
    }): Promise<void> {
        if (oldPath !== undefined && oldPath !== relativePath) {
            // Move the VFS record immediately so that a concurrent
            // scheduleSyncForOfflineChanges scan sees the metadata at
            // the new path and doesn't create a duplicate document.
            const doc = this.vfs.getByPath(oldPath);
            if (doc !== undefined) {
                const existingAtNew = this.vfs.getByPath(relativePath);
                if (
                    existingAtNew === undefined ||
                    existingAtNew.state === "deleted-locally"
                ) {
                    try {
                        this.vfs.move(oldPath, relativePath);
                    } catch {
                        // Target path occupied — leave it for the executor
                    }
                }
            }

            this.queue.enqueue({
                type: "local-move",
                fromPath: oldPath,
                toPath: relativePath
            });
        } else {
            this.queue.enqueue({
                type: "local-update",
                path: relativePath
            });
        }
    }

    public async scheduleSyncForOfflineChanges(): Promise<void> {
        if (this.runningReconciliation !== undefined) {
            this.logger.debug(
                "Uploading local changes is already in progress"
            );
            return this.runningReconciliation;
        }

        const promise = this.internalReconcile();
        this.runningReconciliation = promise;

        try {
            await promise;
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
        } finally {
            if (this.runningReconciliation === promise) {
                this.runningReconciliation = undefined;
            }
        }
    }

    public async waitUntilFinished(): Promise<void> {
        await this.runningReconciliation;
        await this.queue.waitForIdle();
    }

    /**
     * Force a final filesystem scan to catch any operations that were
     * silently dropped (e.g., due to mutable document references
     * pointing to a moved path). Called by the SyncClient after the
     * normal waitUntilFinished completes to ensure eventual consistency.
     */
    public async runFinalConsistencyCheck(): Promise<void> {
        await this.runningReconciliation;
        this.runningReconciliation = undefined;
        await this.scheduleSyncForOfflineChanges();
        await this.queue.waitForIdle();
    }

    public reset(): void {
        this._isFirstSyncComplete = false;
        this.queue.reset();
        this.runningReconciliation = undefined;
    }

    public destroy(): void {
        this.queue.destroy();
        this.eventUnsubscribers.forEach((unsub) => { unsub(); });
        this.eventUnsubscribers.length = 0;
    }

    // -----------------------------------------------------------------------
    // Executor — dispatches CoalescedActions to sync-actions functions
    // -----------------------------------------------------------------------

    private async executeAction(
        _key: string,
        action: CoalescedAction
    ): Promise<void> {
        switch (action.action) {
            case "create": {
                const doc = this.vfs.getByPath(action.path);
                if (doc === undefined) {
                    // Create a pending doc in VFS, then sync
                    const pending = await this.vfs.createPending(action.path);
                    await executeSyncCreate(this.deps, pending);
                } else if (doc.state === "pending") {
                    await executeSyncCreate(this.deps, doc);
                } else if (
                    doc.state === "tracked" &&
                    doc.serverVersion === 0
                ) {
                    // Resolved by resolveIdempotencyKeys but not yet synced.
                    // parentVersionId 0 is a placeholder — treat as create retry.
                    this.logger.debug(
                        `Document ${action.path} has serverVersion 0 from key resolution, retrying sync`
                    );
                    await executeSyncUpdateFull(
                        this.deps,
                        doc,
                        undefined,
                        false
                    );
                } else if (doc.state === "tracked") {
                    // Already tracked — treat as an update instead
                    this.logger.debug(
                        `Document ${action.path} already tracked, treating create as update`
                    );
                    await executeSyncUpdate(this.deps, doc);
                }
                break;
            }

            case "update": {
                // Try path lookup first; fall back to documentId if
                // a concurrent move changed the VFS path after this
                // action was queued.
                const doc =
                    this.vfs.getByPath(action.path) ??
                    (!_key.startsWith("path:")
                        ? this.vfs.getByDocumentId(_key)
                        : undefined);
                if (doc === undefined) {
                    this.logger.debug(
                        `Cannot find document ${action.path} in VFS, skipping update (will be picked up by next filesystem scan)`
                    );
                } else if (doc.state === "tracked") {
                    await executeSyncUpdate(this.deps, doc);
                } else if (doc.state === "pending") {
                    // Pending create, content will be read at sync time
                    await executeSyncCreate(this.deps, doc);
                }
                break;
            }

            case "delete": {
                const doc = this.vfs.getByPath(action.path);
                if (doc === undefined) {
                    this.logger.debug(
                        `Document ${action.path} has already been removed, skipping delete`
                    );
                    break;
                }

                if (doc.state === "pending") {
                    // Never synced — just remove from VFS
                    this.vfs.remove(doc);
                } else if (doc.state === "tracked") {
                    // Mark as deleted locally, then sync
                    const {documentId} = doc;
                    this.vfs.deleteLocally(action.path);
                    const deleted = this.vfs.getByDocumentId(documentId);
                    if (
                        deleted?.state === "deleted-locally"
                    ) {
                        await executeSyncDelete(this.deps, deleted);
                    }
                }
                break;
            }

            case "move":
            case "move-and-update": {
                const doc = this.vfs.getByPath(action.toPath);
                if (doc === undefined) {
                    this.logger.debug(
                        `Cannot find document at ${action.toPath} after move, skipping`
                    );
                } else if (doc.state === "tracked") {
                    await executeSyncUpdate(
                        this.deps,
                        doc,
                        action.fromPath
                    );
                } else if (doc.state === "pending") {
                    // Pending create was renamed — retry the create at
                    // the new path
                    await executeSyncCreate(this.deps, doc);
                }
                break;
            }

            case "remote-update":
            case "remote-delete": {
                const doc = this.vfs.getByDocumentId(
                    action.version.documentId
                );
                await executeRemoteUpdate(
                    this.deps,
                    action.version,
                    doc ?? undefined
                );
                // addSeenUpdateId is called inside the sync-actions functions
                // after each successful operation
                break;
            }

            case "noop":
                break;
        }
    }

    // -----------------------------------------------------------------------
    // Handshake
    // -----------------------------------------------------------------------

    private sendHandshakeMessage(): void {
        const message: WebSocketClientMessage = {
            type: "handshake",
            deviceId: this.deviceId,
            token: this.settings.getSettings().token,
            lastSeenVaultUpdateId: this.vfs.getLastSeenUpdateId()
        };
        this.webSocketManager.sendHandshakeMessage(message);
    }

    // -----------------------------------------------------------------------
    // Offline reconciliation
    // -----------------------------------------------------------------------

    private async internalReconcile(): Promise<void> {
        // Pause the event queue during reconciliation to prevent races
        // between resolveIdempotencyKeys (which transitions pending→tracked)
        // and queued create operations (which expect pending docs).
        // Wait for any currently running operation to finish first.
        this.queue.pause();
        await this.queue.waitForIdle();
        try {
            await this.internalReconcileInner();
        } finally {
            this.queue.resume();
        }
    }

    private async internalReconcileInner(): Promise<void> {
        // 1. Resolve idempotency keys for pending creates
        await this.resolveIdempotencyKeys();

        // 2. Clean up orphaned pending documents: metadata === undefined
        // (never synced) and local file no longer exists (user deleted
        // before sync, then app crashed). Since they were never synced,
        // there's nothing to delete on the server — just remove from VFS.
        for (const pendingDoc of this.vfs.pendingDocuments()) {
            if (!(await this.operations.exists(pendingDoc.relativePath))) {
                this.logger.info(
                    `Removing orphaned pending document at ${pendingDoc.relativePath} — file no longer exists and was never synced`
                );
                this.vfs.remove(pendingDoc);
            }
        }

        // 3. Scan filesystem and reconcile with VFS
        const allLocalFiles =
            await this.operations.listFilesRecursively();
        this.logger.info(
            `Scheduling sync for ${allLocalFiles.length} local files`
        );

        const result = await this.vfs.reconcileWithDisk(
            allLocalFiles,
            async (path) => {
                try {
                    // Bail out if a reset happened
                    if (!this.queue.hasOutstandingWork()) {
                        // Not resetting, proceed
                    }

                    const sizeInBytes =
                        await this.operations.getFileSize(path);
                    const sizeInMB = Math.ceil(sizeInBytes / 1024 / 1024);
                    const { maxFileSizeMB } =
                        this.settings.getSettings();
                    if (sizeInMB > maxFileSizeMB) {
                        return undefined;
                    }

                    const contentBytes =
                        await this.operations.read(path);
                    return hash(contentBytes);
                } catch (e) {
                    if (e instanceof SyncResetError) {
                        throw e;
                    }
                    if (
                        e instanceof Error &&
                        e.name === "FileNotFoundError"
                    ) {
                        return undefined;
                    }
                    this.logger.warn(
                        `Skipping file ${path} due to read error: ${e}`
                    );
                    return undefined;
                }
            }
        );

        // 4. Apply moves to VFS and enqueue move events
        for (const moved of result.movedFiles) {
            const oldPath = moved.document.relativePath;
            try {
                this.vfs.move(oldPath, moved.newPath);
            } catch {
                // Target path occupied — skip this move
                this.logger.info(
                    `Cannot move document from ${oldPath} to ${moved.newPath} — path is occupied`
                );
                continue;
            }
            this.queue.enqueue({
                type: "local-move",
                fromPath: oldPath,
                toPath: moved.newPath
            });
        }

        // 5. Enqueue interrupted deletes (marked deleted locally but
        // server-side delete never completed)
        for (const deletedDoc of this.vfs.deletedLocallyDocuments()) {
            if (!(await this.operations.exists(deletedDoc.relativePath))) {
                this.logger.debug(
                    `Document ${deletedDoc.relativePath} had an interrupted delete, retrying server-side delete`
                );
                // Enqueue as a remote-delete since the doc is already
                // in deleted-locally state — the executor will call
                // executeSyncDelete directly.
                this.queue.enqueue({
                    type: "local-delete",
                    path: deletedDoc.relativePath
                });
            }
        }

        // 6. Enqueue updates for modified files
        for (const modified of result.modifiedFiles) {
            this.logger.debug(
                `Document ${modified.path} might have been updated locally, scheduling sync`
            );
            this.queue.enqueue({
                type: "local-update",
                path: modified.path
            });
        }

        // 7. Enqueue creates for new files.
        // Before scheduling a create, check if the content already exists
        // in a tracked document whose file is also on disk (duplicate
        // detection for ensureClearPath displacements).
        for (const newFile of result.newFiles) {
            let shouldSkip = false;

            // Duplicate content detection
            try {
                const contentBytes = await this.operations.read(newFile);
                const contentHash = hash(contentBytes);
                const trackedDocs = this.vfs.trackedDocuments();
                const duplicateDoc = trackedDocs.find(
                    (doc) =>
                        doc.localHash === contentHash &&
                        doc.relativePath !== newFile
                );
                if (
                    duplicateDoc !== undefined &&
                    (await this.operations.exists(duplicateDoc.relativePath))
                ) {
                    this.logger.info(
                        `File at ${newFile} has same content as tracked document at ${duplicateDoc.relativePath}, deleting duplicate`
                    );
                    await this.operations.delete(newFile);
                    shouldSkip = true;
                }
            } catch {
                // File may have been deleted or unreadable — proceed with create
            }

            if (!shouldSkip) {
                this.logger.debug(
                    `Document ${newFile} not found in VFS, scheduling sync to create it`
                );
                this.queue.enqueue({
                    type: "local-create",
                    path: newFile
                });
            }
        }

        // 8. Enqueue deletes for missing files AFTER creates so that
        // creates can adopt deleted docs via server-side merge.
        for (const missing of result.missingFiles) {
            // Skip deleted-locally docs (already handled above)
            if (missing.state === "deleted-locally") {
                continue;
            }

            // Re-check if the file reappeared (e.g., re-created by a
            // concurrent sync operation)
            if (await this.operations.exists(missing.relativePath)) {
                this.logger.debug(
                    `Document ${missing.relativePath} reappeared on disk, skipping delete`
                );
                continue;
            }

            // Re-check if the document is still in the VFS (it may have
            // been adopted by a concurrent create operation)
            if (!this.vfs.contains(missing)) {
                this.logger.debug(
                    `Document ${missing.relativePath} was adopted by a create, skipping delete`
                );
                continue;
            }

            this.logger.debug(
                `Document ${missing.relativePath} has been deleted locally, scheduling sync to delete it`
            );
            this.queue.enqueue({
                type: "local-delete",
                path: missing.relativePath
            });
        }

        this._isFirstSyncComplete = true;
    }

    // -----------------------------------------------------------------------
    // Idempotency key resolution
    // -----------------------------------------------------------------------

    private async resolveIdempotencyKeys(): Promise<void> {
        const pending = this.vfs.pendingDocuments();
        if (pending.length === 0) {
            return;
        }

        const keys = pending.map((d) => d.idempotencyKey);

        this.logger.debug(
            `Resolving ${keys.length} pending idempotency keys`
        );

        const resolved =
            await this.deps.syncService.resolveIdempotencyKeys(keys);

        for (const doc of pending) {
            const documentId = resolved.get(doc.idempotencyKey);
            if (documentId === undefined) continue;

            // Check if document was removed by a concurrent operation
            if (!this.vfs.contains(doc)) {
                this.logger.info(
                    `Pending doc at ${doc.relativePath} was removed during key resolution, skipping`
                );
                continue;
            }

            // Skip if this documentId is already assigned to another document
            const existing = this.vfs.getByDocumentId(documentId);
            if (existing !== undefined) {
                this.logger.debug(
                    `Document ${documentId} already exists at ${existing.relativePath}, removing stale pending doc at ${doc.relativePath}`
                );
                this.vfs.remove(doc);
                continue;
            }

            this.logger.info(
                `Resolved idempotency key ${doc.idempotencyKey} to document ${documentId} for ${doc.relativePath}`
            );
            this.vfs.assignDocumentId(doc.idempotencyKey, documentId);

            // Migrate the event queue key from path-based to documentId
            this.queue.migrateKey(
                "path:" + doc.relativePath,
                documentId
            );
        }
    }
}
