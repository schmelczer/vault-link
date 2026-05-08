// Two-loop sync engine. The wire loop (this file) keeps records in step
// with the server: HTTP/WS handlers update record fields and write
// content to the file at `record.localPath`. They never move files for
// path placement. The Reconciler (reconciler.ts) handles record↔disk
// path reconciliation, running after every wire-loop drained event.
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
import type { FileOperations } from "../file-operations/file-operations";
import { FileAlreadyExistsError } from "../errors/file-already-exists-error";
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
    type HistoryEntry
} from "../tracing/sync-history";
import { isBinary } from "../utils/is-binary";
import { isFileTypeMergable } from "../utils/is-file-type-mergable";
import { diff } from "reconcile-text";
import type { ServerConfig } from "../services/server-config";
import type { FixedSizeDocumentCache } from "../utils/data-structures/fix-sized-cache";
import { base64ToBytes } from "byte-base64";
import type { DocumentUpdateResponse } from "../services/types/DocumentUpdateResponse";
import { Reconciler } from "./reconciler";

// Internal ignore pattern pinned on the queue at construction time so
// the watcher's enqueue path doesn't pick up Reconciler swap markers.
const VAULTLINK_INTERNAL_DIR_IGNORE = ".vaultlink/**";

export class Syncer {
    public readonly onRemainingOperationsCountChanged = new EventListeners<
        (remainingOperations: number) => unknown
    >();

    private readonly queue: SyncEventQueue;
    private readonly reconciler: Reconciler;
    // Bytes the wire loop received for a doc whose `localPath` is not yet
    // set (e.g. a remote create whose target slot was occupied). Shared
    // with the Reconciler, which consumes (and deletes the entry) when it
    // places the file. Keeping the bytes here avoids a redundant
    // server fetch on the very next reconciler pass.
    private readonly pendingPlacementContent = new Map<
        DocumentId,
        Uint8Array
    >();

    private runningScheduleSyncForOfflineChanges: Promise<void> | undefined;
    private drainPromise: Promise<void> | undefined;
    private drainRequestedWhileRunning = false;
    private isDrainingPaused = false;
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

        // Hide the Reconciler's swap-marker scratch directory from the
        // watcher's enqueue path. Without this, the marker file the
        // Reconciler writes during a cycle swap would race onto the
        // queue as a LocalCreate, and the queue would push that to the
        // server.
        this.queue.addInternalIgnorePattern(VAULTLINK_INTERNAL_DIR_IGNORE);

        this.reconciler = new Reconciler(
            this.logger,
            this.operations,
            this.syncService,
            this.queue,
            this.pendingPlacementContent
        );

        // Fire-and-forget: any swap marker left behind by a crash gets
        // rolled forward before the first wire-loop event runs. Errors
        // are logged inside the reconciler.
        void this.reconciler.recoverFromInterruptedSwap();

        this.webSocketManager.onWebSocketStatusChanged.add((isConnected) => {
            if (isConnected) {
                this.sendHandshakeMessage();
            }
        });
        this.webSocketManager.onRemoteVaultUpdateReceived.add(
            this.syncRemotelyUpdatedFile.bind(this)
        );
        // Funnel every queue mutation (enqueue, consume, clearPending) through
        // the public count notifier so listeners see grow/shrink transitions
        // immediately rather than only when a drain consumes an event.
        this.queue.onPendingUpdateCountChanged.add(() => {
            this.notifyRemainingOperationsChanged();
        });
    }

    /**
     * True while the syncer has *active* work the caller should wait on: a
     * running offline scan or an in-flight drain. Pending queue events alone
     * don't count — `pause()` and `SyncResetError` exit drain early without
     * clearing the queue, and nothing will pick those events back up until
     * sync is re-enabled. Treating queued-but-stuck events as pending work
     * would deadlock `waitUntilFinishedInternal` (the awaits inside its loop
     * are no-ops once the active work has settled).
     *
     * The contract that makes "in-flight only" sufficient: every codepath
     * that enqueues an event ends in `ensureDraining()` (the local-sync
     * methods, `syncRemotelyUpdatedFile`, and the tail of
     * `internalScheduleSyncForOfflineChanges`). So if a WebSocket handler
     * lands new work mid-await, the next loop iteration sees `drainPromise`
     * set and waits on it.
     *
     * Uses `isScanning` rather than `runningScheduleSyncForOfflineChanges`
     * because the latter is a "have we already scanned this session" latch
     * that stays set after the scan resolves.
     */
    public get hasPendingWork(): boolean {
        return this.isScanning || this.drainPromise !== undefined;
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
            this.logger.info(`All local changes have been queued`);
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
        this.previousRemainingOperationsCount = 0;
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

    public pauseDraining(): void {
        this.isDrainingPaused = true;
    }

    public resumeDraining(): void {
        this.isDrainingPaused = false;
        this.ensureDraining();
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
        try {
            this.queue.clearPending(); // can't have conflicts between the offline scan and ongoing operations created during the preceeding pause

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
            this.isScanning = false;
        }

        this.ensureDraining();
    }

    private ensureDraining(): void {
        if (this.drainPromise !== undefined) {
            this.drainRequestedWhileRunning = true;
            return;
        }
        if (this.isScanning) {
            return;
        }
        if (this.isDrainingPaused) {
            return;
        }
        this.drainPromise = this.drain().finally(() => {
            this.drainPromise = undefined;
            const shouldRestart =
                this.drainRequestedWhileRunning &&
                this.queue.pendingUpdateCount > 0 &&
                !this.isScanning &&
                !this.isDrainingPaused &&
                this.settings.getSettings().isSyncEnabled;
            this.drainRequestedWhileRunning = false;
            if (shouldRestart) {
                this.ensureDraining();
            }
        });
    }

    private async drain(): Promise<void> {
        // Peek then remove-after-processing (instead of shift-then-process):
        // the event must remain reachable through `findLatestCreateForPath`
        // while it is in flight, so a rename event arriving mid-process can
        // call `updatePendingCreatePath` to retarget this create's local path.
        for (;;) {
            if (
                this.isDrainingPaused ||
                !this.settings.getSettings().isSyncEnabled
            ) {
                this.logger.debug(
                    "Drain pausing because sync is disabled; events stay queued"
                );
                return;
            }
            const event = this.queue.peekFront();

            if (event === undefined) {
                break;
            }

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
            this.queue.consumeEvent(event);
            // Reconciler runs after every wire-loop step; any record whose
            // localPath drifted from remoteRelativePath gets a chance to
            // converge before the next event. Best-effort — per-record
            // failures are logged and retried on the next pass.
            await this.reconciler.run();
            this.notifyRemainingOperationsChanged();
        }
    }

    private async processEvent(event: SyncEvent): Promise<void> {
        try {
            if (event.type === SyncEventType.LocalCreate) {
                event.isProcessing = true;
            }

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
            // If a LocalCreate fails terminally, queued LocalDelete /
            // LocalUpdate events whose `documentId` is this Create's
            // `resolvers.promise` would `await` it forever — reject the
            // resolver so they fail-fast with the same error class and
            // hit their matching skip/log branch below.
            //
            // Only do this for terminal errors. `SyncResetError` is
            // transient: drain returns without consuming the event, so
            // the next drain retries the same Create. Rejecting the
            // resolver now would permanently poison it, and the eventual
            // `resolveCreate(...resolve)` after the retry succeeds is a
            // no-op on an already-settled promise — leaving every
            // dependent event stuck failing on `await event.documentId`.
            if (
                event.type === SyncEventType.LocalCreate &&
                !(e instanceof SyncResetError)
            ) {
                event.resolvers.promise.catch(() => {
                    /* suppressed */
                });
                event.resolvers.reject(e);
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
                if (event.remoteVersion.isDeleted) {
                    return false;
                }
                sizeInBytes = event.remoteVersion.contentSize;
                ({ relativePath } = event.remoteVersion);
                break;
        }

        const oversizedEntry = this.getHistoryEntryForSkippedOversizedFile(
            sizeInBytes,
            relativePath
        );
        if (oversizedEntry === undefined) {
            return false;
        }

        this.history.addHistoryEntry(oversizedEntry);

        if (event.type === SyncEventType.LocalCreate) {
            event.resolvers.promise.catch(() => {
                /* suppressed */
            });
            event.resolvers.reject(new Error("Create was cancelled"));
        }

        // Advance the cursor so the server doesn't replay this update on every
        // reconnect — the skip is permanent for this version.
        if (event.type === SyncEventType.RemoteChange) {
            this.queue.lastSeenUpdateId = event.remoteVersion.vaultUpdateId;
        }

        return true;
    }

    private getHistoryEntryForSkippedOversizedFile(
        sizeInBytes: number,
        relativePath: RelativePath
    ): HistoryEntry | undefined {
        const sizeInMB = Math.round(sizeInBytes / 1024 / 1024);
        const { maxFileSizeMB } = this.settings.getSettings();
        if (sizeInMB > maxFileSizeMB) {
            return {
                status: SyncStatus.SKIPPED,
                details: {
                    type: SyncType.SKIPPED as const,
                    relativePath
                },
                message: `File size of ${sizeInMB} MB exceeds the maximum file size limit of ${maxFileSizeMB} MB`,
                timestamp: new Date()
            };
        }
    }

    private async processCreate(
        event: Extract<SyncEvent, { type: SyncEventType.LocalCreate }>
    ): Promise<void> {
        const requestPath = event.path;
        const contentBytes = await this.operations.read(requestPath);
        const contentHash = await hash(contentBytes);

        // Use the path the pending create has when it reaches the wire loop.
        // `updatePendingCreatePath` mutates queued creates when a not-yet-sent
        // local file is renamed, so a renamed-away generation does not create
        // a server document at a path that a newer local file has reused.
        //
        // `lastSeenUpdateIdForCreate(requestPath)` (rather than the contiguous
        // `lastSeenUpdateId`) blocks the server from path-merging this POST
        // into a doc we already track at the same path. Without that, a
        // same-device rename race can alias two physically distinct local
        // files onto one docId. See `SyncEventQueue.lastSeenUpdateIdForCreate`.
        const response = await this.syncService.create({
            relativePath: requestPath,
            lastSeenVaultUpdateId:
                this.queue.lastSeenUpdateIdForCreate(requestPath),
            contentBytes
        });

        // Same-docId collapse. While our LocalCreate sat in the queue, a
        // RemoteCreate may have arrived for this same path. The wire-loop's
        // `processRemoteCreateForNewDocument` would have built a record with
        // `localPath === undefined` carrying the same docId the server is
        // about to return us. `upsertRecord` keys by docId and merges in
        // place, so the record we pass below collapses into that existing
        // one — its claim is dropped and `localPath` becomes `event.path`.
        // The reconciler will reconcile if `response.relativePath` differs.
        let remoteHash = contentHash;
        if (response.type === "MergingUpdate") {
            const responseBytes = base64ToBytes(response.contentBase64);
            // Read `event.path` live for both the write target and the
            // cache key. A user rename arriving between HTTP-send and
            // HTTP-response rewrites `event.path` via
            // `updatePendingCreatePath`; the merge write must land on
            // the current slot so the queued LocalUpdate that follows
            // sees the merged bytes.
            await this.operations.write(
                event.path,
                contentBytes,
                responseBytes
            );
            remoteHash = await hash(responseBytes);
            await this.updateCache(
                response.vaultUpdateId,
                responseBytes,
                event.path
            );
        } else {
            await this.updateCache(
                response.vaultUpdateId,
                contentBytes,
                event.path
            );
        }

        // Drop any stashed bytes for this docId — the file is on disk at
        // event.path, so the reconciler shouldn't try to fetch & write
        // its content. (The reconciler's job for this record is now just
        // path placement, if needed.)
        this.pendingPlacementContent.delete(response.documentId);

        // Snapshot `event.path` only after the write has settled. The
        // write itself can drive synchronous watcher callbacks (e.g.
        // an atomic-update fileSystemOperations that fires a "file
        // changed" event back into the queue), and the test harness's
        // user-facing renames also race here. Either path mutates
        // `event.path` via `updatePendingCreatePath`; reading it once
        // up front would lock in a stale slot and leave
        // `record.localPath` pointing at a vacated path with no
        // LocalRename ever materializing.
        const localPath = event.path;

        await this.queue.resolveCreate(event, {
            documentId: response.documentId,
            parentVersionId: response.vaultUpdateId,
            remoteRelativePath: response.relativePath,
            remoteHash,
            localPath
        });

        this.queue.lastSeenUpdateId = response.vaultUpdateId;
        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: { type: SyncType.CREATE, relativePath: localPath },
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
        const record = this.queue.getDocumentByDocumentId(documentId);
        if (
            record?.localPath !== undefined &&
            record.localPath !== event.path
        ) {
            this.logger.debug(
                `Skipping local-delete for ${documentId} at ${event.path}: ` +
                    `record now owns ${record.localPath}`
            );
            return;
        }

        // The disk file is already gone when a LocalDelete reaches the wire
        // loop. This is redundant for settled records deleted through
        // `enqueue`, but load-bearing for creates that were deleted while the
        // create request was still pending: their record only exists after the
        // create ack resolves.
        await this.queue.setLocalPath(documentId, undefined);

        const response = await this.syncService.delete({
            documentId
        });

        // Don't remove the doc from the queue or advance lastSeenUpdateId
        // here. The server broadcasts the delete back to us over the
        // WebSocket; that receipt drives `processRemoteDelete`'s cleanup
        // and history entry. Keeping the entry in the map until then lets
        // late remote updates be recognised as "file is missing" and
        // skipped, instead of resurrecting the doc.
        //
        // Mark the doc as deletion-pending so the Reconciler doesn't
        // resurrect it during the gap between HTTP-ack and WS-receipt.
        // Without this, the LocalDelete enqueue's `setLocalPath(undefined)`
        // leaves the record looking like a "needs initial placement" case
        // to the Reconciler — which would then fetch the pre-delete bytes
        // from the server and write them to disk. The mark also blocks
        // any late RemoteChange from stashing pre-delete bytes into
        // `pendingPlacementContent` (see processRemoteUpdate). The mark is
        // cleared automatically by `removeDocumentById`. We also drop any
        // already-stashed content for this doc since it cannot be placed.
        this.queue.markServerDeletePending(documentId);
        this.pendingPlacementContent.delete(documentId);
        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.DELETE,
                relativePath: event.path
            },
            message: "Successfully deleted file on the server",
            author: response.userId,
            timestamp: new Date(response.updatedDate)
        });
    }

    private async processLocalUpdate(
        event: Extract<SyncEvent, { type: SyncEventType.LocalUpdate }>
    ): Promise<void> {
        const documentId = await event.documentId;

        const record = this.queue.getDocumentByDocumentId(documentId);
        if (record === undefined) {
            // The doc was deleted between this event being queued and
            // drained — skip silently. Common when a LocalDelete drains
            // ahead of a LocalUpdate that was already in the queue.
            this.logger.debug(
                `Skipping local-update for ${documentId} — doc no longer tracked (deleted)`
            );
            return;
        }
        // The record may exist with no local file (e.g. a pending-delete
        // raced ahead and nulled out localPath). Nothing to upload from.
        if (record.localPath === undefined) {
            this.logger.debug(
                `Skipping local-update for ${documentId} — record has no local file`
            );
            return;
        }
        const contentBytes = await this.operations.read(record.localPath);
        const contentHash = await hash(contentBytes);

        // For a user-driven rename the user's intent is `event.originalPath`
        // — that's the rename target. For a content-only edit the user is
        // agnostic to the path; sending one would be wrong if a remote
        // rename processed first, because the server would interpret the
        // user's (now-stale) path as a rename back. So content-only PUTs
        // omit the path and the server keeps the doc at its current
        // server-known location.
        const renameTarget = event.isUserRename
            ? event.originalPath
            : undefined;

        const hashChanged = contentHash !== record.remoteHash;
        const pathChanged =
            renameTarget !== undefined &&
            record.remoteRelativePath !== renameTarget;

        if (!hashChanged && !pathChanged) {
            this.logger.debug(
                `File hash of ${record.localPath} matches last synced version; no need to sync`
            );
            return;
        }

        const response = await this.sendUpdate({
            record,
            relativePath: renameTarget,
            contentBytes
        });

        if (response.isDeleted) {
            await this.processRemoteDelete(record.localPath, {
                ...response,
                contentSize: 0,
                isNewFile: false
            });
            return;
        }

        // Read `record.localPath` live via a fresh queue lookup: the
        // queue's enqueue rename branch mutates the same record object
        // in place across our await on `sendUpdate`, and a displaced-doc
        // cleanup can null it out. The fresh lookup also re-widens the
        // type back to `string | undefined` (the earlier guard narrowed
        // it pre-await). The reconciler handles any further path
        // placement after we write.
        const livePath =
            this.queue.getDocumentByDocumentId(documentId)?.localPath;
        let remoteHash = contentHash;
        if (response.type === "MergingUpdate") {
            const responseBytes = base64ToBytes(response.contentBase64);
            if (livePath !== undefined) {
                await this.operations.write(
                    livePath,
                    contentBytes,
                    responseBytes
                );
            }
            remoteHash = await hash(responseBytes);
            await this.updateCache(
                response.vaultUpdateId,
                responseBytes,
                livePath ?? response.relativePath
            );
        } else {
            await this.updateCache(
                response.vaultUpdateId,
                contentBytes,
                livePath ?? response.relativePath
            );
        }

        await this.queue.upsertRecord({
            documentId: response.documentId,
            parentVersionId: response.vaultUpdateId,
            remoteRelativePath: response.relativePath,
            remoteHash,
            // localPath is owned by the watcher and the reconciler. Pass
            // the value we observed pre-await purely as a hint for the
            // placement-pending → placed transition; `upsertRecord` ignores
            // it when an existing localPath is already set, so a watcher
            // rename that landed during the HTTP roundtrip is preserved.
            localPath: livePath
        });
        this.queue.lastSeenUpdateId = response.vaultUpdateId;

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.UPDATE,
                relativePath: livePath ?? response.relativePath
            },
            message:
                response.type === "MergingUpdate"
                    ? "Updated file and merged with remote changes"
                    : "Successfully updated file on the server",
            author: response.userId,
            timestamp: new Date(response.updatedDate)
        });
    }

    private async processRemoteChange(
        event: Extract<SyncEvent, { type: SyncEventType.RemoteChange }>
    ): Promise<void> {
        const { remoteVersion } = event;
        const trackedRecord = this.queue.getDocumentByDocumentId(
            remoteVersion.documentId
        );

        if (remoteVersion.isDeleted) {
            if (trackedRecord === undefined) {
                // The doc isn't tracked locally — either we never had
                // it (joined the vault after the delete) or a previous
                // delete already cleaned it up. Just advance
                // `lastSeenUpdateId` so we don't replay this on the
                // next reconnect.
                this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;
                return;
            }
            return this.processRemoteDelete(
                trackedRecord.localPath,
                remoteVersion
            );
        }

        if (
            (trackedRecord?.parentVersionId ?? 0) >= remoteVersion.vaultUpdateId
        ) {
            this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;
            this.logger.debug(
                `Document ${remoteVersion.relativePath} is already up-to-date or has newer local changes; skipping remote update`
            );
            return;
        }

        // Server-side delete is in flight: our HTTP DELETE has been acked
        // but the WebSocket receipt that would `removeDocumentById` hasn't
        // arrived yet. Any remote update we apply here would resurrect the
        // doc — either by writing the pre-delete bytes to disk
        // (`processRemoteUpdate` with localPath set) or by stashing them
        // for the Reconciler (`processRemoteUpdate` with localPath
        // undefined; reconciler is also gated, but stashing leaves
        // `pendingPlacementContent` lingering which a same-docId
        // re-creation could later misuse). Advance the watermark and
        // discard; the eventual delete-receipt will clean up the record.
        if (
            trackedRecord !== undefined &&
            this.queue.hasPendingServerDelete(trackedRecord.documentId)
        ) {
            this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;
            this.logger.debug(
                `Discarding remote update for ${remoteVersion.documentId}: ` +
                    `local HTTP DELETE has been acked; awaiting WS receipt`
            );
            return;
        }

        if (trackedRecord !== undefined) {
            // The doc is tracked, but the disk slot can be stale. One
            // concrete race: a remote create quick-writes a file, a
            // watcher rename/delete lands before the record is fully
            // settled, and the record is left claiming a path that no
            // longer exists. If no queued local operation owns that
            // disappearance, clear the localPath and let
            // processRemoteUpdate stash/place the active server version.
            if (trackedRecord.localPath !== undefined) {
                const fileExists = await this.operations.exists(
                    trackedRecord.localPath
                );
                if (
                    !fileExists &&
                    !this.queue.hasPendingLocalEventsForDocumentId(
                        remoteVersion.documentId
                    )
                ) {
                    this.logger.debug(
                        `Remote update for ${remoteVersion.documentId}: ` +
                            `local file at ${trackedRecord.localPath} is missing; ` +
                            `clearing localPath for placement`
                    );
                    await this.queue.setLocalPath(
                        trackedRecord.documentId,
                        undefined
                    );
                }
            }
            return this.processRemoteUpdate(trackedRecord, remoteVersion);
        }

        if (!remoteVersion.isNewFile) {
            this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;
            this.logger.debug(
                `Ignoring stale RemoteChange for untracked, non-new document ${remoteVersion.documentId}`
            );
            return;
        }

        return this.processRemoteCreateForNewDocument(remoteVersion);
    }

    private async processRemoteDelete(
        localPath: RelativePath | undefined,
        remoteVersion: DocumentVersionWithoutContent
    ): Promise<void> {
        if (localPath !== undefined) {
            // Verify the record still owns this disk slot before deleting.
            // A same-path recreate (LocalCreate at this path resolving
            // after we sent the server-delete for this doc) installs a
            // new doc into byLocalPath but doesn't clear the old record's
            // stale `localPath` field. When the WS broadcast for the old
            // doc's deletion arrives, naively deleting at `localPath`
            // would clobber the new doc's file. Skip the disk delete
            // when the slot now belongs to a different doc; the queue
            // record cleanup below still runs.
            const currentOwner = this.queue.byLocalPath.get(localPath);
            if (
                currentOwner === undefined ||
                currentOwner.documentId === remoteVersion.documentId
            ) {
                await this.operations.delete(localPath);
            } else {
                this.logger.debug(
                    `Skipping disk delete for ${remoteVersion.documentId} at ${localPath}: ` +
                        `slot is now owned by ${currentOwner.documentId}`
                );
            }
        }
        await this.queue.removeDocumentById(remoteVersion.documentId);

        this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.DELETE,
                relativePath: localPath ?? remoteVersion.relativePath
            },
            message:
                "Successfully deleted file which had been deleted remotely",
            author: remoteVersion.userId,
            timestamp: new Date(remoteVersion.updatedDate)
        });
    }

    private async processRemoteUpdate(
        record: DocumentRecord,
        remoteVersion: DocumentVersionWithoutContent
    ): Promise<void> {
        if (
            this.queue.hasPendingLocalEventsForDocumentId(
                remoteVersion.documentId
            )
        ) {
            // The user has queued local edits for this doc. Apply them
            // first — they'll round-trip to the server, get merged
            // there, and broadcast back. If we processed this remote
            // update now, `FileOperations.write` would receive
            // `expected = current = the disk content (which already
            // includes the user's pending edits)`, so the 3-way merge
            // baseline collapses to "no local change vs base" and
            // returns `theirs`, silently dropping the user's bytes.
            // Re-enqueueing (rather than just deferring with a flag)
            // is correct because by the time the queued local events
            // drain, this remote update may be stale: our
            // `parentVersionId` advances past `remoteVersion.vaultUpdateId`,
            // and the next pass's standard "stale" check at the top of
            // `processRemoteChange` will discard it.
            //
            // Broader concern (out of scope here): the 3-way merge
            // baseline in `FileOperations.write` is the most-recent
            // disk read at every callsite, not the previous server
            // version. That's correct for the post-server-merge writes
            // in `processCreate` / `processLocalUpdate` (we're
            // applying the server's merged result to our potentially
            // newer disk state), but fundamentally wrong as a base for
            // a true 3-way merge. The defer gate above sidesteps the
            // only call pattern where it actually loses data today.
            void this.syncRemotelyUpdatedFile({ document: remoteVersion });
            return;
        }

        const remoteContent = await this.syncService.getDocumentVersionContent({
            documentId: remoteVersion.documentId,
            vaultUpdateId: remoteVersion.vaultUpdateId
        });

        // `record.localPath` may be undefined — the record was created on
        // a previous remote-create whose target slot was occupied at
        // receive time. In that case stash the bytes for the reconciler
        // to write when it places the file; we still update the wire
        // fields so the catch-up doesn't replay this version.
        //
        // The slot may also have been shadowed: the record still claims
        // `localPath = P`, but `byLocalPath[P]` now points at a different
        // doc (a same-path recreate installed a new owner without
        // clearing this record's stale field — same race shape as the
        // processRemoteDelete fix above). Writing to a shadowed slot
        // would clobber the new owner's bytes. Clear the stale claim now
        // so the reconciler treats this record as placement-pending; the
        // closing `upsertRecord` no longer touches an existing record's
        // localPath, so the clear has to happen explicitly here.
        const claimedPath = record.localPath;
        const livePath =
            claimedPath !== undefined &&
            this.queue.byLocalPath.get(claimedPath)?.documentId ===
                record.documentId
                ? claimedPath
                : undefined;
        if (claimedPath !== undefined && livePath === undefined) {
            this.logger.debug(
                `Remote update for ${record.documentId} at claimed ${claimedPath} ` +
                    `but slot is shadowed; clearing stale claim and deferring to reconciler`
            );
            await this.queue.setLocalPath(record.documentId, undefined);
        }
        if (livePath !== undefined) {
            const currentContent = await this.operations.read(livePath);
            // Re-check the entry-time gate immediately before the disk
            // mutation. The `await`s on `getDocumentVersionContent` and
            // `read` open a TOCTOU window during which a LocalUpdate
            // for this doc could have been enqueued by the watcher. If
            // we proceeded, `operations.write` would receive
            // `expected = current = disk-content-already-with-user-bytes`,
            // collapsing the 3-way merge baseline and silently
            // overwriting the user's pending edits with `theirs`.
            // Re-enqueueing the RemoteChange is the same fix shape as
            // the entry-time gate above; the next pass either applies
            // it or discards it as stale via the standard check at the
            // top of `processRemoteChange`.
            if (
                this.queue.hasPendingLocalEventsForDocumentId(
                    remoteVersion.documentId
                )
            ) {
                void this.syncRemotelyUpdatedFile({ document: remoteVersion });
                return;
            }
            // Re-check shadowing as well: the same TOCTOU window
            // (between `getDocumentVersionContent` and `read`, plus
            // `read` itself) could see a same-path recreate steal the
            // slot. If we lost ownership, fall through to the
            // pendingPlacementContent stash by re-entering the
            // RemoteChange — the next pass observes the updated
            // byLocalPath and routes correctly.
            if (
                this.queue.byLocalPath.get(livePath)?.documentId !==
                record.documentId
            ) {
                void this.syncRemotelyUpdatedFile({ document: remoteVersion });
                return;
            }
            await this.operations.write(
                livePath,
                currentContent,
                remoteContent
            );
            await this.updateCache(
                remoteVersion.vaultUpdateId,
                remoteContent,
                livePath
            );
        } else {
            this.pendingPlacementContent.set(
                remoteVersion.documentId,
                remoteContent
            );
            await this.updateCache(
                remoteVersion.vaultUpdateId,
                remoteContent,
                remoteVersion.relativePath
            );
        }

        await this.queue.upsertRecord({
            documentId: record.documentId,
            parentVersionId: remoteVersion.vaultUpdateId,
            remoteRelativePath: remoteVersion.relativePath,
            remoteHash: await hash(remoteContent),
            localPath: livePath
        });
        this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.UPDATE,
                relativePath: livePath ?? remoteVersion.relativePath
            },
            message: "Successfully applied remote update",
            author: remoteVersion.userId,
            timestamp: new Date(remoteVersion.updatedDate)
        });
    }

    private async processRemoteCreateForNewDocument(
        remoteVersion: DocumentVersionWithoutContent
    ): Promise<void> {
        // Quick-write optimization: if the target slot is free right now
        // (no disk file, no tracked record), fetch and write inline. The
        // catch-up replay leans on this — without it, a freshly-joined
        // client would upsert every doc with `localPath = undefined`
        // and rely on the reconciler to fetch each one back.
        //
        // If the slot is occupied, defer: leave `localPath = undefined`
        // and let the reconciler place once the slot frees. Per the
        // design, no buffering at receive time — the reconciler will
        // fetch on demand.
        const target = remoteVersion.relativePath;
        const slotFree = await this.canPlaceRemoteCreateAt(target);

        let localPath: RelativePath | undefined = undefined;
        let remoteHash: string | undefined = undefined;
        if (slotFree) {
            const remoteContent =
                await this.syncService.getDocumentVersionContent({
                    documentId: remoteVersion.documentId,
                    vaultUpdateId: remoteVersion.vaultUpdateId
                });
            if (!(await this.canPlaceRemoteCreateAt(target))) {
                this.logger.debug(
                    `Quick-write for ${remoteVersion.documentId} at ${target} ` +
                        `became blocked while fetching content; deferring to reconciler`
                );
            } else {
                try {
                    remoteHash = await hash(remoteContent);
                    await this.queue.upsertRecord({
                        documentId: remoteVersion.documentId,
                        parentVersionId: remoteVersion.vaultUpdateId,
                        remoteRelativePath: remoteVersion.relativePath,
                        remoteHash,
                        localPath: target
                    });
                    const result = await this.operations.create(
                        target,
                        remoteContent
                    );
                    const liveRecord = this.queue.getDocumentByDocumentId(
                        remoteVersion.documentId
                    );
                    localPath =
                        liveRecord === undefined
                            ? result.actualPath
                            : liveRecord.localPath;
                    await this.updateCache(
                        remoteVersion.vaultUpdateId,
                        remoteContent,
                        localPath ?? remoteVersion.relativePath
                    );
                } catch (e) {
                    await this.queue.setLocalPath(
                        remoteVersion.documentId,
                        undefined
                    );
                    if (!(e instanceof FileAlreadyExistsError)) {
                        throw e;
                    }
                    // TOCTOU: the slot was free at the pre-check but
                    // something landed there between then and now. Fall
                    // through to the no-localPath branch and let the
                    // reconciler retry placement once the slot frees.
                    this.logger.debug(
                        `Quick-write for ${remoteVersion.documentId} at ${target} ` +
                            `lost a TOCTOU race; deferring to reconciler`
                    );
                    localPath = undefined;
                }
            }
        }

        if (
            this.queue.getDocumentByDocumentId(remoteVersion.documentId) ===
            undefined
        ) {
            await this.queue.upsertRecord({
                documentId: remoteVersion.documentId,
                parentVersionId: remoteVersion.vaultUpdateId,
                remoteRelativePath: remoteVersion.relativePath,
                // `remoteHash` is undefined when we deferred fetching content.
                // Consumers (`processLocalUpdate`'s fast-skip,
                // `findMatchingFile`'s offline-rename detection) treat
                // undefined as "no comparison possible" and fall through to a
                // real upload / no-match. The hash gets populated the next
                // time we observe a real version (a remote update, or a
                // local edit that triggers an upload).
                remoteHash,
                localPath
            });
        }

        this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;

        if (localPath !== undefined) {
            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: {
                    type: SyncType.CREATE,
                    relativePath: localPath
                },
                message:
                    "Successfully downloaded remote file which hadn't existed locally",
                author: remoteVersion.userId,
                timestamp: new Date(remoteVersion.updatedDate)
            });
        }
    }

    private async canPlaceRemoteCreateAt(
        target: RelativePath
    ): Promise<boolean> {
        return (
            !this.queue.hasPendingCreateForPath(target) &&
            !(await this.operations.exists(target)) &&
            this.queue.getRecordByLocalPath(target) === undefined
        );
    }

    private async sendUpdate({
        record,
        relativePath,
        contentBytes
    }: {
        record: DocumentRecord;
        // `undefined` for content-only edits; the server keeps the doc's
        // current path. A string is sent only on a user-driven rename.
        relativePath: RelativePath | undefined;
        contentBytes: Uint8Array;
    }): Promise<DocumentUpdateResponse> {
        const isText =
            !isBinary(contentBytes) &&
            isFileTypeMergable(
                relativePath ?? record.remoteRelativePath,
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
