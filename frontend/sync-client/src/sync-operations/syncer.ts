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
import { CONFLICT_PATH_REGEX } from "./conflict-path";
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
        // Funnel every queue mutation (enqueue, consume, clearPending) through
        // the public count notifier so listeners see grow/shrink transitions
        // immediately rather than only when a drain consumes an event.
        this.queue.onPendingUpdateCountChanged.add(() => {
            this.notifyRemainingOperationsChanged();
        });
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
            this.queue.setIgnoreConflictPaths(true);
            this.isScanning = false;
        }

        this.ensureDraining();
    }

    private ensureDraining(): void {
        if (this.drainPromise !== undefined) { return; }
        if (this.isScanning) { return; }
        this.drainPromise = this.drain().finally(() => {
            this.drainPromise = undefined;
        });
    }

    private async drain(): Promise<void> {
        // Peek then remove-after-processing (instead of shift-then-process):
        // the event must remain reachable through `findLatestCreateForPath`
        // while it is in flight, so a rename event arriving mid-process can
        // call `updatePendingCreatePath` to retarget this create's path.
        while (true) {
            if (!this.settings.getSettings().isSyncEnabled) {
                this.logger.debug(
                    "Drain pausing because sync is disabled; events stay queued"
                );
                return;
            }
            const event = this.queue.peekFront();

            if (event === undefined) { break; }

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
            // Stashes (`intendedPath` set) hang waiting for the slot to
            // free up — usually the occupant has a pending RemoteChange
            // that vacates the path on a later drain step. Sweep after
            // every event so a rename or delete that just freed a slot
            // pulls any waiting doc onto the canonical path immediately.
            // Without this, the stash sits at a `conflict-<uuid>-` path
            // and the cross-agent assertion (and any user-visible state)
            // diverges from the rest of the vault.
            await this.unwindReadyStashes();
            this.notifyRemainingOperationsChanged();
        }
    }

    private async unwindReadyStashes(): Promise<void> {
        for (const record of this.queue.allSettledDocuments().values()) {
            if (
                record.intendedPath === undefined ||
                record.intendedPath === record.path
            ) {
                continue;
            }
            // Skip when the canonical slot is still in use — by another
            // tracked doc OR by an untracked file (e.g. another agent's
            // pending LocalCreate). Trying the move anyway would deflect
            // through `MoveOnConflict.NEW` to a fresh `conflict-<uuid>-`
            // path and orphan the file there with our record stuck on
            // its old path.
            const blocker = this.queue.getSettledDocumentByPath(
                record.intendedPath
            );
            if (
                blocker !== undefined &&
                blocker.documentId !== record.documentId
            ) {
                continue;
            }
            if (await this.operations.exists(record.intendedPath)) {
                continue;
            }
            // Skip if our own source file is gone (e.g. a LocalDelete
            // for this record drained but its server receipt hasn't
            // arrived to clear the record yet). Otherwise the move
            // throws FileNotFoundError.
            if (!(await this.operations.exists(record.path))) {
                continue;
            }
            await this.operations.move(
                record.path,
                record.intendedPath,
                MoveOnConflict.NEW
            );
            await this.queue.setDocument(record.intendedPath, {
                ...record,
                path: record.intendedPath,
                intendedPath: undefined
            });
        }
    }

    private async processEvent(event: SyncEvent): Promise<void> {
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
        let relativePath: RelativePath;

        switch (event.type) {
            case SyncEventType.LocalDelete:
                return false;
            case SyncEventType.LocalCreate:
            case SyncEventType.LocalUpdate:
                sizeInBytes = await this.operations.getFileSize(event.path);
                relativePath = event.path;
                break;
            case SyncEventType.RemoteChange:
                if (event.remoteVersion.isDeleted) { return false; }
                sizeInBytes = event.remoteVersion.contentSize;
                ({ relativePath } = event.remoteVersion);
                break;
        }

        const oversizedEntry = this.getHistoryEntryForSkippedOversizedFile(
            sizeInBytes,
            relativePath
        );
        if (oversizedEntry === undefined) { return false; }

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
        const contentBytes = await this.operations.read(event.path);
        const contentHash = await hash(contentBytes);

        const response = await this.syncService.create({
            relativePath: event.originalPath,
            lastSeenVaultUpdateId: this.queue.lastSeenUpdateId,
            contentBytes
        });

        // `event.path` is mutated in place by `updatePendingCreatePath`
        // when a user renames the pending create mid-roundtrip, so we
        // read it live on every access — capturing it into a local
        // would freeze it at function entry and write the merged bytes
        // to the now-vacated path.
        let remoteHash: string;
        if (response.type === "MergingUpdate") {
            const responseBytes = base64ToBytes(response.contentBase64);
            await this.operations.write(event.path, contentBytes, responseBytes);
            remoteHash = await hash(responseBytes);
            await this.updateCache(response.vaultUpdateId, responseBytes, event.path);
        } else {
            remoteHash = contentHash;
            await this.updateCache(response.vaultUpdateId, contentBytes, event.path);
        }

        const newRecord = {
            documentId: response.documentId,
            parentVersionId: response.vaultUpdateId,
            remoteRelativePath: response.relativePath
        };

        // Displacement-merge: while this LocalCreate sat in the queue, a
        // RemoteCreate for `originalPath` was processed first, displaced
        // our local file to a `conflict-…` path, and tracked the remote
        // doc at `originalPath`. The server then de-duplicated our
        // create into that already-tracked doc and returned its id.
        // Slot the merged content into `response.relativePath` by
        // deleting D's stale content there and renaming the conflict
        // file in. Falling through to the regular `resolveCreate` path
        // would call `setDocument(conflict-…, D)`, whose same-docId
        // cleanup strips D's tracking from `originalPath` and orphans
        // the file there.
        const existing = this.queue.getDocumentByDocumentId(response.documentId);
        if (
            existing !== undefined &&
            existing.path === response.relativePath &&
            existing.path !== event.path
        ) {
            // We can't `operations.write` the merged bytes onto the
            // existing path: that runs a 3-way merge against the stale
            // content as if it were a concurrent edit, which strips
            // out the very content the server just merged.
            await this.operations.delete(response.relativePath);
            // We just deleted `response.relativePath`. With
            // `MoveOnConflict.NEW` a stray racing occupant would route
            // our file to a `conflict-<uuid>-` path; we'd then track
            // the doc there with `intendedPath` set.
            const moveResult = await this.operations.move(
                event.path,
                response.relativePath,
                MoveOnConflict.NEW
            );
            // Retarget the create event (and any queued
            // LocalUpdate/LocalDelete keyed off its still-Promise
            // documentId) onto the file's new disk location, so
            // `resolveCreate`'s subsequent `setDocument` finds them and
            // rewrites their `event.path`.
            this.queue.updatePendingCreatePath(
                event.path,
                moveResult.actualPath
            );
            await this.queue.resolveCreate(event, {
                ...newRecord,
                path: moveResult.actualPath,
                intendedPath:
                    moveResult.actualPath === response.relativePath
                        ? undefined
                        : response.relativePath,
                remoteHash
            });
            this.queue.lastSeenUpdateId = response.vaultUpdateId;
            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: { type: SyncType.CREATE, relativePath: event.path },
                message: "Created file and merged with existing remote version",
                author: response.userId,
                timestamp: new Date(response.updatedDate)
            });
            return;
        }

        // Reconcile disk and tracking with the server-assigned path.
        // Two cases produce a mismatch:
        //   1. Server deconflicted (e.g. another client raced us): we
        //      know because `response.relativePath !== event.originalPath`.
        //      Move the local file to the server-assigned path, otherwise
        //      a later remote create at our original path would see a
        //      phantom local conflict and stash the new file under
        //      `conflict-<uuid>-`.
        //   2. The create's local file was displaced to a `conflict-…`
        //      path while it sat in the queue, but the server still
        //      placed the doc at our original path (e.g. the existing
        //      doc that forced the displacement was meanwhile deleted,
        //      so the server-side merge / deconflict path didn't fire).
        //      Move the conflict file onto the original path so
        //      `resolveCreate` tracks the doc at the path the server
        //      returned, instead of the displaced conflict path which
        //      would orphan the file.
        //
        // We must NOT move when `event.path` differs from `originalPath`
        // because of a *user rename* of the pending create (e.g. write
        // A.md, rename to B.md): there the user's intent is the renamed
        // path, the server places the doc at `originalPath`, and the
        // queued `LocalUpdate` from the watcher will replay the rename
        // to the server.
        let resolvedPath = event.path;
        let resolvedIntendedPath: RelativePath | undefined;
        const needsMove =
            response.relativePath !== event.originalPath ||
            (event.path !== response.relativePath &&
                CONFLICT_PATH_REGEX.test(event.path));
        if (needsMove) {
            const moveResult = await this.operations.move(
                event.path,
                response.relativePath,
                MoveOnConflict.NEW
            );
            this.queue.updatePendingCreatePath(event.path, moveResult.actualPath);
            resolvedPath = moveResult.actualPath;
            resolvedIntendedPath =
                moveResult.actualPath === response.relativePath
                    ? undefined
                    : response.relativePath;
        }
        // The server may have de-duplicated this create against an
        // existing doc the client already tracks (e.g. another agent's
        // earlier RemoteCreate that landed at a `conflict-<uuid>-` stash
        // because our pending LocalCreate file was on the canonical
        // slot). The displacement-merge branch above handles the case
        // where the existing record sits at `response.relativePath`;
        // here we handle the symmetric case — existing record at a
        // stash path, our merged content sitting at `resolvedPath`.
        // `setDocument` (called by `resolveCreate`) relocates the
        // record's tracking onto `resolvedPath` but leaves the stash
        // file behind. Delete it before the relocation so the on-disk
        // state matches the doc tracking and the file doesn't outlive
        // its record.
        // if (existing !== undefined && existing.path !== resolvedPath) {
        //     await this.operations.delete(existing.path);
        // }
        await this.queue.resolveCreate(event, {
            ...newRecord,
            path: resolvedPath,
            intendedPath: resolvedIntendedPath,
            remoteHash
        });

        this.queue.lastSeenUpdateId = response.vaultUpdateId;
        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: { type: SyncType.CREATE, relativePath: event.path },
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

        const response = await this.syncService.delete({
            documentId,
        });

        // Don't remove the doc from the queue or advance lastSeenUpdateId
        // here. The server broadcasts the delete back to us over the
        // WebSocket; that receipt drives `processRemoteDelete`'s cleanup
        // and history entry. Keeping the entry in the map until then lets
        // late remote updates be recognised as "file is missing" and
        // skipped, instead of resurrecting the doc.
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
        const contentBytes = await this.operations.read(record.path);
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
                `File hash of ${record.path} matches last synced version; no need to sync`
            );
            return;
        }

        // Snapshot of `record.path` before the HTTP roundtrip — used
        // after the response to detect a user rename that ran while we
        // were awaiting (`record.path !== pathBeforeRoundtrip`). All
        // other reads go through `record.path` live so the merged
        // bytes land at the user's new location, not the vacated one.
        const pathBeforeRoundtrip = record.path;

        const response = await this.sendUpdate({
            record,
            relativePath: renameTarget,
            contentBytes
        });

        if (response.isDeleted) {
            await this.processRemoteDelete(record.path, {
                ...response,
                contentSize: 0,
                isNewFile: false
            });
            return;
        }

        let remoteHash: string;
        if (response.type === "MergingUpdate") {
            const responseBytes = base64ToBytes(response.contentBase64);
            await this.operations.write(record.path, contentBytes, responseBytes);
            remoteHash = await hash(responseBytes);
            await this.updateCache(response.vaultUpdateId, responseBytes, record.path);
        } else {
            remoteHash = contentHash;
            await this.updateCache(response.vaultUpdateId, contentBytes, record.path);
        }

        const newRecord = {
            documentId: response.documentId,
            parentVersionId: response.vaultUpdateId,
            remoteRelativePath: response.relativePath
        };

        if (record.path === pathBeforeRoundtrip) {
            // No user rename mid-flight. Move our local file onto the
            // server-assigned path. The slot may be locally occupied by:
            //   1. Another tracked doc — keep `MoveOnConflict.NEW` so we
            //      stash ourselves at `conflict-<uuid>-` and record
            //      `intendedPath`; evicting their tracking would orphan
            //      their disk file when the next remote update arrives.
            //   2. An untracked file (typically this agent's own pending
            //      LocalCreate whose disk file is sitting at the same
            //      slot the user-rename targeted) — use
            //      `MoveOnConflict.EXISTING` so our server-confirmed
            //      claim wins. We retarget the displaced LocalCreate's
            //      `event.path` so its drain reads from the new
            //      location; on its own server roundtrip the server
            //      will deconflict (we already hold the slot remotely),
            //      and `processCreate` will land it at the server-side
            //      deconflict path.
            const occupant = this.queue.getSettledDocumentByPath(
                response.relativePath
            );
            const conflictMode =
                occupant !== undefined &&
                    occupant.documentId !== record.documentId
                    ? MoveOnConflict.NEW
                    : MoveOnConflict.EXISTING;
            const moveResult = await this.operations.move(
                record.path,
                response.relativePath,
                conflictMode
            );
            this.queue.updatePendingCreatePath(record.path, moveResult.actualPath);
            if (moveResult.displacedTo !== undefined) {
                this.queue.updatePendingCreatePath(
                    response.relativePath,
                    moveResult.displacedTo
                );
            }
            await this.queue.setDocument(moveResult.actualPath, {
                ...newRecord,
                path: moveResult.actualPath,
                intendedPath:
                    moveResult.actualPath === response.relativePath
                        ? undefined
                        : response.relativePath,
                remoteHash
            });
        } else {
            // User renamed during the roundtrip. Leave the disk file at
            // `record.path`; the queued rename's LocalUpdate will
            // reconcile the server on its next drain.
            await this.queue.setDocument(record.path, {
                ...newRecord,
                path: record.path,
                remoteHash
            });
        }

        this.queue.lastSeenUpdateId = response.vaultUpdateId;

        this.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.UPDATE,
                relativePath: record.path
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
                trackedRecord.path,
                remoteVersion
            );
        }

        if (
            (trackedRecord?.parentVersionId ?? 0) >=
            remoteVersion.vaultUpdateId
        ) {
            this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;
            this.logger.debug(
                `Document ${remoteVersion.relativePath} is already up-to-date or has newer local changes; skipping remote update`
            );
            return;
        }

        if (trackedRecord !== undefined) {
            // The doc is tracked. If the local file backing it has
            // gone missing — e.g. the user deleted it and the
            // LocalDelete hasn't drained yet, or our HTTP DELETE just
            // landed and we're still waiting on the WebSocket receipt
            // — ignore the update. Otherwise we'd try to operate on a
            // vanished file (or recreate one we're tearing down).
            const fileExists = await this.operations.exists(
                trackedRecord.path
            );
            if (!fileExists) {
                this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;
                this.logger.debug(
                    `Ignoring remote update for ${remoteVersion.documentId}: local file at ${trackedRecord.path} is missing`
                );
                return;
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
        record: DocumentRecord,
        remoteVersion: DocumentVersionWithoutContent
    ): Promise<void> {
        // Defer the remote update if a local event is queued for this
        // doc: the local drain owns the user's intent (rename target,
        // edited content) and will sync it to the server, which then
        // broadcasts the merged result back. Touching disk or the
        // record now races the local drain — the disk move would
        // vacate the path the queued LocalUpdate later reads from,
        // and `setDocument(record.path, …)` couldn't reconcile with
        // `actualPath` without clobbering the user's renamed entry.
        // Re-queueing keeps `lastSeenUpdateId` consistent without
        // those side effects.
        if (
            this.queue.hasPendingLocalEventsForDocumentId(
                remoteVersion.documentId
            )
        ) {
            void this.syncRemotelyUpdatedFile({
                document: remoteVersion
            });
            return;
        }

        const pathBeforeRoundtrip = record.path;
        // Mirror the conflict-mode policy from `processLocalUpdate`'s
        // post-roundtrip move: only protect the slot when it's held by
        // a *different tracked* doc (manual user resolution required).
        // An untracked occupant is typically this agent's own pending
        // LocalCreate whose drain hasn't reached the server yet — the
        // server will deconflict the create on its own roundtrip and
        // the `processCreate` post-move will land that file at the
        // server-assigned path. Displacing it here is the right call;
        // routing this remote update to a `conflict-<uuid>-` stash
        // would leave a permanent local-only divergence.
        const occupant = this.queue.getSettledDocumentByPath(
            remoteVersion.relativePath
        );
        const conflictMode =
            occupant !== undefined &&
                occupant.documentId !== record.documentId
                ? MoveOnConflict.NEW
                : MoveOnConflict.EXISTING;
        const moveResult = await this.operations.move(
            record.path,
            remoteVersion.relativePath,
            conflictMode
        );
        const { actualPath } = moveResult;
        const intendedPath =
            actualPath === remoteVersion.relativePath
                ? undefined
                : remoteVersion.relativePath;
        if (moveResult.displacedTo !== undefined) {
            this.queue.updatePendingCreatePath(
                remoteVersion.relativePath,
                moveResult.displacedTo
            );
        }
        const currentContent = await this.operations.read(actualPath);
        const remoteContent = await this.syncService.getDocumentVersionContent({
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
            path: actualPath,
            intendedPath,
            parentVersionId: remoteVersion.vaultUpdateId,
            remoteRelativePath: remoteVersion.relativePath,
            remoteHash: await hash(remoteContent)
        });
        this.queue.lastSeenUpdateId = remoteVersion.vaultUpdateId;

        if (actualPath !== pathBeforeRoundtrip) {
            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: {
                    type: SyncType.MOVE,
                    relativePath: actualPath,
                    movedFrom: pathBeforeRoundtrip
                },
                message: `File was renamed remotely from ${pathBeforeRoundtrip} to ${actualPath}`,
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

        // Stash *ourselves* at a `conflict-<uuid>-` path when the slot is
        // locally occupied: a remote create's content is brand new to us,
        // so deferring our local placement until any earlier work at this
        // slot resolves is safer than evicting the occupant. The
        // pending-LocalCreate case naturally unwinds through the server's
        // own deconflict: when our create's HTTP runs, the server sees
        // `remoteVersion`'s doc already there and routes ours to a
        // sibling path, freeing the slot for us to set ourselves on the
        // next time the remote-create-followed-by-rename pair drains
        // through the queue.
        const createResult = await this.operations.create(
            remoteVersion.relativePath,
            remoteContent,
            MoveOnConflict.NEW
        );
        const { actualPath } = createResult;
        const intendedPath =
            actualPath === remoteVersion.relativePath
                ? undefined
                : remoteVersion.relativePath;

        await this.updateCache(
            remoteVersion.vaultUpdateId,
            remoteContent,
            actualPath
        );

        const contentHash = await hash(remoteContent);
        await this.queue.setDocument(actualPath, {
            path: actualPath,
            intendedPath,
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
