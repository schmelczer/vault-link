import type { SyncHistory } from "../tracing/sync-history";
import { SyncStatus, SyncType } from "../tracing/sync-history";
import { v4 as uuid } from "uuid";
import { base64ToBytes } from "byte-base64";
import { diff } from "reconcile-text";
import type {
    Database,
    EngineState,
    StoredSnapshot
} from "../persistence/database";
import { emptyState } from "../persistence/database";
import type {
    FileOperations,
    FileWrite
} from "../file-operations/file-operations";
import type { Settings } from "../persistence/settings";
import type { SyncService } from "../services/sync-service";
import type { ServerConfig } from "../services/server-config";
import type { WebSocketManager } from "../services/websocket-manager";
import type { DocumentVersion } from "../services/types/DocumentVersion";
import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";
import type { EventBatch } from "../services/types/EventBatch";
import type { EventRecord } from "../services/types/EventRecord";
import type { FileManifest } from "../services/types/FileManifest";
import type { VaultSnapshot } from "../services/types/VaultSnapshot";
import type { PushContent } from "../services/types/PushContent";
import type { Logger } from "../tracing/logger";
import { EventListeners } from "../utils/data-structures/event-listeners";
import { mergeContent, toStoredSnapshot } from "./content";
import { scanLocalFiles, type LocalChange } from "./scan";
import {
    mergeFileManifests,
    resolvePaths,
    sameFileManifest,
    validateFileManifest
} from "./file-manifest";
import { removeFromArray } from "../utils/remove-from-array";
import { isInternalPath } from "../utils/portable-path";
import { isBinary } from "../utils/is-binary";
import { isFileTypeMergable } from "../utils/is-file-type-mergable";
import type { FixedSizeDocumentCache } from "../utils/data-structures/fix-sized-cache";
import {
    AuthenticationError,
    LocalChangesDuringReconciliation,
    PermanentSyncError,
    ServerVersionMismatchError,
    SyncResetError,
    ServerHistoryChangedError
} from "../errors/errors";

export class Syncer {
    public readonly onReadyForEvents = new EventListeners<() => void>();
    public readonly onServerHistoryChanged = new EventListeners<() => void>();
    public readonly onRemainingOperationsCountChanged = new EventListeners<
        (count: number) => unknown
    >();

    private running?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private stopped = true;
    private dirty = false;
    private localGeneration = 0;
    private failure?: unknown;
    private readonly changes: LocalChange[];
    private notificationSaving: Promise<void> = Promise.resolve();
    private notificationSaveFailed = false;
    private readonly pendingPaths = new Set<string>();
    private unsyncablePaths = new Set<string>();
    private hasScanned = false;

    public constructor(
        deviceId: string,
        private readonly logger: Logger,
        private readonly database: Database,
        private readonly settings: Settings,
        private readonly service: SyncService,
        websocket: WebSocketManager,
        private readonly files: FileOperations,
        private readonly serverConfig: ServerConfig,
        private readonly history: SyncHistory,
        private readonly contentCache: FixedSizeDocumentCache,
        private readonly localChangeStorage: {
            entries: LocalChange[];
            save: (entries: LocalChange[]) => Promise<void>;
        } = { entries: [], save: async () => {} }
    ) {
        this.changes = localChangeStorage.entries;
        websocket.onWebSocketStatusChanged.add((connected) => {
            if (connected) {
                websocket.sendHandshakeMessage({
                    type: "handshake",
                    token: settings.getSettings().token,
                    deviceId
                });
            }
            // Failed upgrades and lost transports still need HTTP catchup,
            // including when the optional polling interval is disabled.
            this.wake();
        });
        websocket.onRemoteVaultUpdateReceived.add(async () => {
            this.wake();
        });
    }

    public get isFirstSyncComplete(): boolean {
        return this.database.state.initialized;
    }

    public get hasLocalChanges(): boolean {
        return this.changes.length > 0;
    }

    public get isBusy(): boolean {
        return (
            !!this.running ||
            this.dirty ||
            !!this.database.state.pending ||
            !!this.failure ||
            !!this.rejectionMessage
        );
    }

    public isDocumentUpToDate(path: string): boolean {
        if (
            !this.database.state.initialized ||
            !this.hasScanned ||
            this.pendingPaths.has(path) ||
            this.unsyncablePaths.has(path) ||
            this.settings.isIgnored(path)
        ) {
            return false;
        }

        const record = this.database.getLatestDocumentByRelativePath(path);
        if (!record) return false;
        const document = this.database.state.documents[record.documentId];
        if (
            !document?.materialized ||
            !document.base ||
            document.bootstrap ||
            document.observedHash !== document.base.hash ||
            this.database.state.fileManifest.entries[record.documentId] !== path
        ) {
            return false;
        }

        const remote = this.database.state.remoteHeads[record.documentId];
        if (remote && remote.vaultUpdateId > document.base.vaultUpdateId)
            return false;

        const { pending } = this.database.state;
        if (
            pending?.type === "content" &&
            pending.documentId === record.documentId
        ) {
            return false;
        }
        if (
            pending?.type === "fileManifest" &&
            pending.request.entries[record.documentId] !==
                this.database.state.fileManifest.entries[record.documentId]
        ) {
            return false;
        }

        return true;
    }

    public start(): void {
        this.stopped = false;
        this.failure = undefined;
        this.hasScanned = false;
        this.wake();
    }

    public async stop(): Promise<void> {
        this.stopped = true;
        clearTimeout(this.timer);
        await this.running;
    }

    public wake(): void {
        if (this.stopped) {
            return;
        }

        this.dirty = true;

        if (this.running) {
            return;
        }

        clearTimeout(this.timer);

        this.running = this.run().finally(() => {
            this.running = undefined;
            this.onRemainingOperationsCountChanged.trigger(
                this.failure ||
                    this.database.state.pending ||
                    this.rejectionMessage
                    ? 1
                    : 0
            );

            if (this.stopped) {
                return;
            }

            if (this.dirty && !this.failure) {
                this.wake();
                return;
            }

            if (
                this.failure instanceof PermanentSyncError ||
                this.failure instanceof AuthenticationError ||
                this.failure instanceof ServerVersionMismatchError
            ) {
                return;
            }

            const intervalMs =
                this.failure === undefined
                    ? this.settings.getSettings().syncIntervalMs
                    : this.settings.getSettings().networkRetryIntervalMs;
            if (intervalMs === undefined || intervalMs === 0) {
                return;
            }

            this.timer = setTimeout(() => {
                this.wake();
            }, intervalMs);
        });
    }

    public async waitUntilFinished(): Promise<void> {
        while (this.running) {
            await this.running;
        }
        if (this.failure) {
            throw this.failure;
        }
        if (this.rejectionMessage)
            throw new PermanentSyncError(this.rejectionMessage);
    }

    public async syncLocallyCreatedFile(_path: string): Promise<void> {
        this.localGeneration++;
        this.pendingPaths.add(_path);
        await this.recordLocalChange({ type: "create", path: _path });
    }

    public async syncLocallyDeletedFile(_path: string): Promise<void> {
        this.localGeneration++;
        this.pendingPaths.add(_path);
        await this.recordLocalChange({ type: "delete", path: _path });
    }

    public async syncLocallyUpdatedFile({
        oldPath,
        relativePath
    }: {
        oldPath?: string;
        relativePath: string;
    }): Promise<void> {
        // Content snapshots are re-read before writing. Only namespace
        // notifications invalidate an identity plan; keystrokes must not starve
        // a complete scan of unrelated documents.
        if (oldPath !== undefined && oldPath !== "") this.localGeneration++;
        this.pendingPaths.add(relativePath);
        if (oldPath) this.pendingPaths.add(oldPath);
        if (
            oldPath &&
            !isInternalPath(oldPath) &&
            !isInternalPath(relativePath)
        ) {
            await this.recordLocalChange({
                type: "move",
                oldPath,
                relativePath
            });
        }
        this.wake();
    }

    /** Reload an uncertain metadata save before starting another attempt. */
    public async reloadLocalState(): Promise<void> {
        await this.flushLocalChanges();
        await this.database.recoverPersistence();
    }

    private async recordLocalChange(change: LocalChange): Promise<void> {
        change.changeId = uuid();
        const previous = [...this.changes];
        this.changes.push(change);
        const saving = this.notificationSaving.then(async () => {
            await this.files.captureChange(change, previous);
            await this.localChangeStorage.save(structuredClone(this.changes));
            this.notificationSaveFailed = false;
        });
        this.notificationSaving = saving.catch(() => {
            this.notificationSaveFailed = true;
        });
        try {
            await saving;
        } finally {
            this.wake();
        }
    }

    public async flushLocalChanges(): Promise<void> {
        await this.notificationSaving;
        if (this.notificationSaveFailed) {
            await this.localChangeStorage.save(structuredClone(this.changes));
            this.notificationSaveFailed = false;
        }
    }

    private async run(): Promise<void> {
        this.onRemainingOperationsCountChanged.trigger(1);
        this.failure = undefined;
        try {
            await this.reloadLocalState();
            if (
                this.database.state.historyRecovery ||
                (this.database.state.initialized &&
                    this.service.verifiesHistory &&
                    !this.service.hasHistoryCheckpoint)
            )
                await this.recoverServerHistory();
            await this.serverConfig.initialize();
            if (!this.database.state.initialized) {
                await this.bootstrap();
            }
            if (!this.stopped) this.onReadyForEvents.trigger();
            do {
                this.dirty = false;
                // An unknown accepted request must be resolved before observing a
                // newer base, otherwise we can merge our own edit a second time.
                if (this.database.state.pending) {
                    await this.finishPending();
                }
                await this.scan();
                const batch = await this.service.events(
                    this.database.state.lastSeenUpdateId
                );
                await this.incorporateEventBatch(batch);
                await this.scan();
                // Previously excluded content becomes eligible after a setting
                // change. Its saved obligation survives advancing the cursor.
                if (Object.keys(this.database.state.excluded ?? {}).length)
                    await this.incorporateFileManifest(
                        this.database.state.fileManifest
                    );
                for (const head of Object.values(
                    this.database.state.remoteHeads
                )) {
                    const doc = this.database.state.documents[head.documentId];
                    if (
                        this.database.state.local[head.documentId] !==
                            undefined &&
                        (!doc?.materialized ||
                            !doc.base ||
                            doc.bootstrap ||
                            doc.base.vaultUpdateId < head.vaultUpdateId)
                    ) {
                        await this.incorporateContent(head);
                    }
                }
                if (await this.preparePush()) {
                    await this.finishPending();
                    this.dirty = true;
                }
            } while (this.dirty && !this.stopped);
            if (!this.dirty && !this.database.state.pending)
                this.pendingPaths.clear();
        } catch (error) {
            if (error instanceof ServerHistoryChangedError && !this.stopped) {
                try {
                    await this.recoverServerHistory();
                    this.dirty = true;
                    return;
                } catch (recoveryError) {
                    error = recoveryError;
                }
            }
            if (error instanceof LocalChangesDuringReconciliation) {
                this.dirty = true;
                return;
            }
            if (!(error instanceof SyncResetError && this.stopped)) {
                this.failure = error;
                this.serverConfig.reset();
                this.logger.error(`Sync paused for retry: ${String(error)}`);
            }
        }
    }

    private async recoverServerHistory(): Promise<void> {
        this.onServerHistoryChanged.trigger();
        this.contentCache.reset();
        this.hasScanned = false;
        if (!this.database.state.historyRecovery) {
            await this.scan();
            const guard = this.localGuard();
            const previous = this.database.state;
            const next = emptyState(previous.vaultKey);
            next.historyRecovery = true;
            next.lastAppliedLocalChangeId = previous.lastAppliedLocalChangeId;
            next.protectedPaths = previous.protectedPaths;
            for (const [id, path] of Object.entries(previous.local)) {
                const info = await this.files.fs.stat(path);
                if (info?.kind !== "file") continue;
                const doc = previous.documents[id];
                if (
                    this.settings.isIgnored(path) ||
                    this.settings.isOversized(info.size)
                ) {
                    next.local[id] = path;
                    next.documents[id] = {
                        materialized: true,
                        bootstrap: true
                    };
                    (next.excluded ??= {})[id] =
                        previous.fileManifest.entries[id] ?? null;
                    continue;
                }
                const snapshot = await this.files.snapshot(path);
                if (!snapshot) throw new LocalChangesDuringReconciliation();
                // An unsent edit from the abandoned history is a separate local
                // document. It must never be diffed against a reused version ID.
                const clean = doc?.base?.hash === snapshot.hash;
                const localId = doc?.base && !clean ? uuid() : id;
                next.local[localId] = path;
                next.documents[localId] = {
                    materialized: true,
                    observedHash: snapshot.hash,
                    recoveryBase: clean ? snapshot : doc?.recoveryBase
                };
            }
            guard();
            // Persist the reset BEFORE releasing the old checkpoint. After a
            // crash no old request can be retried against the replacement log.
            await this.database.commit(next);
        }
        await this.service.resetHistory();
        const next = this.next();
        delete next.historyRecovery;
        await this.database.commit(next);
    }

    private localGuard(): () => void {
        const generation = this.localGeneration;
        return () => {
            if (generation !== this.localGeneration) {
                throw new LocalChangesDuringReconciliation();
            }
        };
    }

    private async cacheContent(
        updateId: number,
        path: string | undefined,
        content: Uint8Array
    ): Promise<void> {
        if (
            path !== undefined &&
            !isBinary(content) &&
            isFileTypeMergable(
                path,
                (await this.serverConfig.getConfig()).mergeableFileExtensions
            )
        ) {
            this.contentCache.put(updateId, content);
        }
    }

    private async pushContent(
        path: string,
        parentVersionId: number | undefined,
        snapshot: StoredSnapshot
    ): Promise<PushContent> {
        const content = base64ToBytes(snapshot.contentBase64);
        const parent =
            parentVersionId === undefined
                ? undefined
                : this.contentCache.get(parentVersionId);
        if (
            parent !== undefined &&
            !isBinary(content) &&
            !isBinary(parent) &&
            isFileTypeMergable(
                path,
                (await this.serverConfig.getConfig()).mergeableFileExtensions
            )
        ) {
            const decode = (bytes: Uint8Array): string =>
                new TextDecoder("utf-8", {
                    fatal: true,
                    ignoreBOM: true
                }).decode(bytes);
            const value = diff(decode(parent), decode(content));
            // Match the server's work bound; large edit sets remain syncable.
            if (value.length <= 10_000) return { type: "Diff", value };
        }

        return { type: "Snapshot", value: snapshot.contentBase64 };
    }

    private next(): EngineState {
        return structuredClone(this.database.state);
    }

    private async bootstrap(): Promise<void> {
        let vaultSnapshot = this.database.state.bootstrap;
        if (!vaultSnapshot) {
            vaultSnapshot = await this.service.vaultSnapshot();
            validateFileManifest(vaultSnapshot.fileManifest.entries);
            await this.database.commit({
                ...this.next(),
                bootstrap: vaultSnapshot
            });
        }
        await this.scan(vaultSnapshot);
        await this.incorporateFileManifest(
            vaultSnapshot.fileManifest,
            vaultSnapshot.headEventId,
            vaultSnapshot
        );
    }

    private async scan(initial?: VaultSnapshot): Promise<void> {
        await this.flushLocalChanges();
        this.unsyncablePaths = await scanLocalFiles(
            {
                next: this.next(),
                guard: this.localGuard(),
                changes: this.changes,
                files: this.files,
                ignored: (path) => this.settings.isIgnored(path),
                oversized: (size) => this.settings.isOversized(size),
                commit: async (next) => this.database.commit(next)
            },
            initial
        );
        this.hasScanned = true;
        await this.localChangeStorage.save(structuredClone(this.changes));
    }

    private async incorporateEventBatch(batch: EventBatch): Promise<void> {
        let cursor = this.database.state.lastSeenUpdateId;
        let manifest = this.database.state.fileManifest;
        const heads = { ...this.database.state.remoteHeads };
        const receipts: EventRecord[] = [];
        // Fold every page before touching local files. If fetching is interrupted,
        // discard this work and retry from the last committed cursor.
        for (;;) {
            const after = cursor;
            for (const event of batch.events) {
                if (event.eventId <= cursor) continue;
                if (event.eventId !== cursor + 1)
                    throw new PermanentSyncError(
                        "Non-contiguous event history; refusing to skip changes"
                    );
                cursor = event.eventId;
                if (
                    this.database.state.unconfirmed?.some(
                        (pending) =>
                            pending.request.requestId === event.requestId
                    ) === true
                )
                    receipts.push(event);
                if (event.type === "fileManifest") {
                    if (
                        event.fileManifest.fileManifestId >
                        manifest.fileManifestId
                    )
                        manifest = event.fileManifest;
                } else if (
                    !heads[event.document.documentId] ||
                    heads[event.document.documentId].vaultUpdateId <
                        event.document.vaultUpdateId
                ) {
                    heads[event.document.documentId] = this.documentHead(
                        event.document
                    );
                }
            }
            const end = batch.endEventId ?? batch.headEventId;
            if (
                end !== cursor ||
                end > batch.headEventId ||
                (end === after && end < batch.headEventId)
            )
                throw new PermanentSyncError("Incomplete event batch");
            if (end === batch.headEventId) break;
            batch = await this.service.events(cursor);
        }
        if (cursor === this.database.state.lastSeenUpdateId) return;
        // Recover our submitted bases before folding later remote edits. A
        // permanent retry failure cannot cancel an earlier in-flight attempt.
        const next = this.next();
        let acknowledged = false;
        for (const event of receipts) {
            const pending = next.unconfirmed?.find(
                (candidate) => candidate.request.requestId === event.requestId
            );
            if (!pending) continue;
            if (event.type === "content" && pending.type === "content") {
                const doc = next.documents[pending.documentId];
                if (!doc.base || doc.base.vaultUpdateId < event.eventId) {
                    doc.base = {
                        ...event.document,
                        hash: pending.snapshot.hash
                    };
                    doc.bootstrap = false;
                    delete doc.rejected;
                    await this.cacheContent(
                        event.eventId,
                        next.local[pending.documentId],
                        base64ToBytes(pending.snapshot.contentBase64)
                    );
                }
            } else if (
                event.type === "fileManifest" &&
                pending.type === "fileManifest"
            ) {
                if (next.fileManifest.fileManifestId < event.eventId) {
                    next.fileManifest = event.fileManifest;
                    delete next.rejectedManifest;
                }
            } else
                throw new PermanentSyncError(
                    "Request receipt type does not match submission"
                );
            if (next.unconfirmed) removeFromArray(next.unconfirmed, pending);
            acknowledged = true;
        }
        if (acknowledged) await this.database.commit(next);
        // Three-way merging compares snapshots. Replaying intermediate remote
        // edits can discard a local edit even when the remote ends at its base.
        await this.incorporateFileManifest(
            manifest,
            cursor,
            undefined,
            false,
            heads
        );
    }

    private documentHead(
        version: DocumentVersionWithoutContent
    ): DocumentVersionWithoutContent {
        return {
            vaultUpdateId: version.vaultUpdateId,
            documentId: version.documentId,
            updatedDate: version.updatedDate,
            userId: version.userId,
            deviceId: version.deviceId,
            contentSize: version.contentSize
        };
    }

    private recordManifestApplication(
        before: Readonly<Record<string, string>>,
        writes: Readonly<Record<string, FileWrite>>
    ): void {
        const after = this.database.state.local;
        for (const id of new Set([
            ...Object.keys(before),
            ...Object.keys(after)
        ])) {
            const from = before[id];
            const to = after[id];
            if (from === to && !writes[id]) continue;
            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                message: "Remote change applied",
                details:
                    from && to && from !== to
                        ? {
                              type: SyncType.MOVE,
                              relativePath: to,
                              movedFrom: from
                          }
                        : !from && to
                          ? { type: SyncType.CREATE, relativePath: to }
                          : from && !to
                            ? { type: SyncType.DELETE, relativePath: from }
                            : {
                                  type: SyncType.UPDATE,
                                  relativePath: to ?? from
                              }
            });
        }
    }

    private async remoteSnapshot(
        head: DocumentVersionWithoutContent,
        path: string,
        supplied?: DocumentVersion
    ): Promise<StoredSnapshot> {
        const content =
            supplied !== undefined
                ? base64ToBytes(supplied.contentBase64)
                : await this.service.getDocumentVersionContent({
                      documentId: head.documentId,
                      vaultUpdateId: head.vaultUpdateId
                  });
        await this.cacheContent(head.vaultUpdateId, path, content);
        return toStoredSnapshot({ content });
    }

    private async contentWrite(
        next: EngineState,
        head: DocumentVersionWithoutContent,
        path: string,
        supplied?: DocumentVersion
    ): Promise<FileWrite | undefined> {
        const document = (next.documents[head.documentId] ??= {
            materialized: false
        });
        if (
            next.excluded?.[head.documentId] !== undefined ||
            this.settings.isIgnored(path) ||
            this.settings.isOversized(head.contentSize)
        ) {
            return undefined;
        }
        const currentPath = this.database.state.local[head.documentId];
        const local =
            currentPath &&
            (await this.files.fs.stat(currentPath))?.kind === "file"
                ? await this.files.snapshot(currentPath)
                : undefined;
        if (
            local !== undefined &&
            this.settings.isOversized(base64ToBytes(local.contentBase64).length)
        ) {
            return undefined;
        }
        const base =
            document.recoveryBase ??
            (local !== undefined &&
            document.base !== undefined &&
            document.bootstrap !== true
                ? await this.remoteSnapshot(document.base, path)
                : undefined);
        // Cache the new head after the older merge base so it remains the most
        // recently used version and can back the follow-up local diff.
        const remote = await this.remoteSnapshot(head, path, supplied);
        let result = remote;
        if (local !== undefined) {
            result = await mergeContent(
                path,
                base,
                local,
                remote,
                (await this.serverConfig.getConfig()).mergeableFileExtensions
            );
        }
        document.base = { ...this.documentHead(head), hash: remote.hash };
        delete document.recoveryBase;
        document.bootstrap = false;
        document.materialized = true;
        document.observedHash = result.hash;
        return local?.contentBase64 === result.contentBase64
            ? undefined
            : { expected: local, replacement: result };
    }

    private async incorporateContent(
        head: DocumentVersionWithoutContent,
        cursor?: number,
        supplied?: DocumentVersion,
        clearPending = false
    ): Promise<void> {
        await this.scan();
        const guard = this.localGuard();
        const next = this.next();
        if (
            !next.remoteHeads[head.documentId] ||
            next.remoteHeads[head.documentId].vaultUpdateId < head.vaultUpdateId
        ) {
            next.remoteHeads[head.documentId] = this.documentHead(head);
        }
        if (cursor !== undefined) {
            next.lastSeenUpdateId = cursor;
        }
        if (clearPending) {
            delete next.pending;
        }
        const path = next.local[head.documentId];
        const document = next.documents[head.documentId];
        const wasMaterialized = document?.materialized;
        const writes: Record<string, FileWrite> = {};
        if (
            path !== undefined &&
            (!document?.base ||
                !document.materialized ||
                document.bootstrap ||
                document.base.vaultUpdateId < head.vaultUpdateId)
        ) {
            const write = await this.contentWrite(next, head, path, supplied);
            if (write) {
                writes[head.documentId] = write;
            }
        }
        await this.files.apply(next, writes, guard);
        if (path !== undefined && writes[head.documentId]) {
            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                message: "Remote content applied",
                details: {
                    type: wasMaterialized ? SyncType.UPDATE : SyncType.CREATE,
                    relativePath: path
                },
                author: head.userId,
                timestamp: new Date(head.updatedDate)
            });
        }
    }

    private async incorporateFileManifest(
        remote: FileManifest,
        cursor?: number,
        initial?: VaultSnapshot,
        clearPending = false,
        heads?: EngineState["remoteHeads"]
    ): Promise<void> {
        validateFileManifest(remote.entries);
        await this.scan(initial);
        const before = { ...this.database.state.local };
        const guard = this.localGuard();
        const next = this.next();
        if (cursor !== undefined) {
            next.lastSeenUpdateId = cursor;
        }
        if (clearPending) {
            delete next.pending;
        }
        if (remote.fileManifestId < next.fileManifest.fileManifestId) {
            await this.database.commit(next);
            return;
        }

        const base = { ...next.fileManifest.entries };
        for (const [id, path] of Object.entries(next.excluded ?? {})) {
            if (path === null) delete base[id];
            else base[id] = path;
        }
        const previousManifest = next.fileManifest.entries;
        next.local = mergeFileManifests(base, next.local, remote.entries);
        next.fileManifest = remote;
        if (heads) next.remoteHeads = heads;
        for (const [id, oldPath] of Object.entries(before)) {
            const path = next.local[id];
            if (
                this.settings.isIgnored(oldPath) ||
                this.unsyncablePaths.has(oldPath) ||
                (path !== undefined && this.settings.isIgnored(path))
            ) {
                next.excluded ??= {};
                if (next.excluded[id] === undefined)
                    next.excluded[id] = previousManifest[id] ?? null;
                next.local[id] = oldPath;
            } else if (next.excluded) delete next.excluded[id];
        }
        for (const [id, path] of Object.entries(next.excluded ?? {})) {
            if (
                before[id] === undefined &&
                (path === null || !this.settings.isIgnored(path))
            )
                delete next.excluded![id];
        }
        next.local = resolvePaths(
            next.local,
            remote.entries,
            Object.keys(next.excluded ?? {}),
            next.protectedPaths
        );
        if (initial) {
            next.initialized = true;
            delete next.bootstrap;
            for (const head of initial.documents) {
                next.remoteHeads[head.documentId] = this.documentHead(head);
            }
        }
        const writes: Record<string, FileWrite> = {};
        for (const [id, path] of Object.entries(next.local)) {
            next.documents[id] ??= { materialized: false };
            if (before[id] === undefined)
                next.documents[id].materialized = false;
            if (
                next.excluded?.[id] === undefined &&
                !this.settings.isIgnored(path) &&
                remote.entries[id] !== undefined &&
                (!this.database.state.local[id] ||
                    !next.documents[id].base ||
                    next.documents[id].bootstrap ||
                    !next.documents[id].materialized ||
                    (next.remoteHeads[id]?.vaultUpdateId ?? 0) >
                        (next.documents[id].base?.vaultUpdateId ?? 0))
            ) {
                const knownHead =
                    next.remoteHeads[id] ??
                    initial?.documents.find((doc) => doc.documentId === id);
                const head = knownHead ?? (await this.service.metadata(id));
                if (!head) {
                    throw new PermanentSyncError(
                        `File manifest references missing content: ${id}`
                    );
                }
                next.remoteHeads[id] = this.documentHead(head);
                const write = await this.contentWrite(next, head, path);
                if (write) {
                    writes[id] = write;
                }
            }
        }
        await this.files.apply(next, writes, guard);
        this.recordManifestApplication(before, writes);
    }

    private async preparePush(): Promise<boolean> {
        if (this.stopped) {
            return false;
        }

        let guard = this.localGuard();
        const canonical = resolvePaths(
            this.database.state.local,
            this.database.state.fileManifest.entries,
            Object.keys(this.database.state.excluded ?? {}),
            this.database.state.protectedPaths
        );
        if (!sameFileManifest(canonical, this.database.state.local)) {
            await this.files.apply(
                { ...this.next(), local: canonical },
                {},
                guard
            );
            await this.scan();
            guard = this.localGuard();
        }

        // Resolve the map after restoring excluded server paths, then make
        // those allocations visible locally before submitting a manifest.
        const submitted = this.manifestToSubmit();
        const local = { ...this.database.state.local };
        for (const [id, path] of Object.entries(submitted))
            if (this.database.state.excluded?.[id] === undefined)
                local[id] = path;
        if (!sameFileManifest(local, this.database.state.local)) {
            await this.files.apply({ ...this.next(), local }, {}, guard);
            await this.scan();
            guard = this.localGuard();
        }
        for (const [id, path] of Object.entries(this.database.state.local)) {
            if (
                this.settings.isIgnored(path) ||
                this.database.state.excluded?.[id] !== undefined ||
                !this.database.state.documents[id]?.materialized ||
                this.unsyncablePaths.has(path) ||
                this.settings.isOversized(
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Document heads are a sparse ID map at runtime.
                    this.database.state.remoteHeads[id]?.contentSize ?? 0
                )
            ) {
                continue;
            }
            const snapshot = await this.files.snapshot(path);
            if (
                !snapshot ||
                this.settings.isOversized(
                    base64ToBytes(snapshot.contentBase64).length
                )
            ) {
                continue;
            }
            const { base, rejected } = this.database.state.documents[id];
            if (
                base?.hash === snapshot.hash ||
                rejected?.hash === snapshot.hash
            ) {
                continue;
            }
            guard();
            await this.database.commit({
                ...this.next(),
                pending: {
                    type: "content",
                    documentId: id,
                    snapshot,
                    request: {
                        requestId: uuid(),
                        parentVersionId: base?.vaultUpdateId ?? null,
                        content: await this.pushContent(
                            path,
                            base?.vaultUpdateId,
                            snapshot
                        )
                    }
                }
            });
            return true;
        }

        const entries = this.manifestToSubmit();
        validateFileManifest(entries);
        if (
            !sameFileManifest(
                entries,
                this.database.state.fileManifest.entries
            ) &&
            (!this.database.state.rejectedManifest ||
                !sameFileManifest(
                    entries,
                    this.database.state.rejectedManifest.entries
                ))
        ) {
            guard();
            await this.database.commit({
                ...this.next(),
                pending: {
                    type: "fileManifest",
                    request: {
                        requestId: uuid(),
                        parentFileManifestId:
                            this.database.state.fileManifest.fileManifestId,
                        entries
                    }
                }
            });
            return true;
        }
        return false;
    }

    private manifestToSubmit(): Record<string, string> {
        // Do not publish a new document until its initial content is acknowledged.
        const entries = { ...this.database.state.local };
        for (const id of Object.keys(this.database.state.excluded ?? {})) {
            const remotePath = this.database.state.fileManifest.entries[id];
            if (remotePath === undefined) delete entries[id];
            else entries[id] = remotePath;
        }
        for (const id of Object.keys(entries)) {
            if (
                !this.database.state.documents[id]?.base &&
                this.database.state.fileManifest.entries[id] === undefined
            ) {
                delete entries[id];
            }
        }
        return resolvePaths(
            entries,
            this.database.state.fileManifest.entries,
            Object.keys(this.database.state.excluded ?? {}),
            [
                ...(this.database.state.protectedPaths ?? []),
                ...Object.keys(this.database.state.excluded ?? {}).flatMap(
                    (id) =>
                        this.database.state.local[id]
                            ? [this.database.state.local[id]]
                            : []
                )
            ]
        );
    }

    private get rejectionMessage(): string | undefined {
        const { state } = this.database;
        for (const [id, path] of Object.entries(state.local ?? {})) {
            const doc = state.documents[id];
            if (
                doc?.rejected &&
                doc.observedHash === doc.rejected.hash &&
                doc.base?.hash !== doc.rejected.hash &&
                !this.settings.isIgnored(path) &&
                state.excluded?.[id] === undefined
            )
                return doc.rejected.message;
        }
        if (
            state.rejectedManifest &&
            sameFileManifest(
                this.manifestToSubmit(),
                state.rejectedManifest.entries
            ) &&
            !sameFileManifest(
                state.fileManifest.entries,
                state.rejectedManifest.entries
            )
        )
            return state.rejectedManifest.message;
        return undefined;
    }

    /** An explicit reset or settings change permits fresh attempts after rejection. */
    public async retryRejectedRequests(): Promise<void> {
        await this.database.recoverPersistence();
        const next = structuredClone(this.database.state);
        let changed = false;
        if (next.rejectedManifest) {
            delete next.rejectedManifest;
            changed = true;
        }
        for (const doc of Object.values(next.documents)) {
            if (doc.rejected) {
                delete doc.rejected;
                changed = true;
            }
        }
        if (changed) await this.database.commit(next);
    }

    private async finishPending(): Promise<void> {
        let { pending } = this.database.state;
        if (!pending) {
            return;
        }

        if (!pending.response && !pending.rejection) {
            const copy = structuredClone(pending);
            try {
                if (copy.type === "content") {
                    copy.response = await this.service.putFileContent(
                        copy.documentId,
                        copy.request
                    );
                } else {
                    copy.response = await this.service.pushFileManifest(
                        copy.request
                    );
                }
            } catch (error) {
                if (!(error instanceof PermanentSyncError)) throw error;
                copy.rejection = error.message;
            }
            await this.database.commit({ ...this.next(), pending: copy });
            pending = copy;
        }

        if (pending.rejection && !pending.response) {
            const next = this.next();
            if (pending.type === "content") {
                next.documents[pending.documentId].rejected = {
                    hash: pending.snapshot.hash,
                    message: pending.rejection
                };
            } else
                next.rejectedManifest = {
                    entries: pending.request.entries,
                    message: pending.rejection
                };
            (next.unconfirmed ??= []).push(pending);
            delete next.pending;
            await this.database.commit(next);
            this.history.addHistoryEntry({
                status: SyncStatus.ERROR,
                message: pending.rejection,
                details: {
                    type: SyncType.SKIPPED,
                    relativePath:
                        pending.type === "content"
                            ? (next.local[pending.documentId] ??
                              pending.documentId)
                            : "File manifest"
                }
            });
            return;
        }

        if (pending.type === "fileManifest") {
            const response = pending.response!;
            if (response.type === "StaleBase") {
                await this.incorporateFileManifest(
                    response,
                    undefined,
                    undefined,
                    true
                );
            } else {
                const next = this.next();
                delete next.rejectedManifest;
                next.fileManifest = {
                    fileManifestId: response.fileManifestId,
                    entries: pending.request.entries
                };
                delete next.pending;
                const previous = this.database.state.fileManifest.entries;
                await this.database.commit(next);
                for (const id of new Set([
                    ...Object.keys(previous),
                    ...Object.keys(next.fileManifest.entries)
                ])) {
                    const before = previous[id],
                        after = next.fileManifest.entries[id];
                    if (before === after) {
                        continue;
                    }
                    this.history.addHistoryEntry({
                        status: SyncStatus.SUCCESS,
                        message: "File manifest change committed",
                        details:
                            after === undefined
                                ? {
                                      type: SyncType.DELETE,
                                      relativePath: before
                                  }
                                : before === undefined
                                  ? {
                                        type: SyncType.CREATE,
                                        relativePath: after
                                    }
                                  : {
                                        type: SyncType.MOVE,
                                        relativePath: after,
                                        movedFrom: before
                                    }
                    });
                }
            }
        } else {
            const response = pending.response!;
            if (response.type === "StaleBase") {
                await this.incorporateContent(
                    response,
                    undefined,
                    undefined,
                    true
                );
            } else {
                const next = this.next();
                const doc = (next.documents[pending.documentId] ??= {
                    materialized: false
                });
                doc.base = {
                    ...this.documentHead(response),
                    hash: pending.snapshot.hash
                };
                doc.bootstrap = false;
                delete doc.rejected;
                next.remoteHeads[pending.documentId] =
                    this.documentHead(response);
                delete next.pending;
                await this.database.commit(next);
                const path = next.local[pending.documentId];
                await this.cacheContent(
                    response.vaultUpdateId,
                    path,
                    base64ToBytes(pending.snapshot.contentBase64)
                );
                this.history.addHistoryEntry({
                    status: SyncStatus.SUCCESS,
                    message: "Content committed",
                    details: {
                        type: SyncType.UPDATE,
                        relativePath:
                            next.local[pending.documentId] ?? pending.documentId
                    },
                    author: response.userId,
                    timestamp: new Date(response.updatedDate)
                });
            }
        }
    }
}
