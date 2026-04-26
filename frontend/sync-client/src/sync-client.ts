import type { PersistenceProvider } from "./persistence/persistence";
import type { HistoryEntry, HistoryStats } from "./tracing/sync-history";
import { SyncHistory } from "./tracing/sync-history";
import { Logger, LogLevel, LogLine } from "./tracing/logger";
import type { RelativePath, StoredSyncState } from "./sync-operations/types";
import { SyncEventQueue } from "./sync-operations/sync-event-queue";
import * as Sentry from "@sentry/browser";
import type { SyncSettings } from "./persistence/settings";
import { DEFAULT_SETTINGS, Settings } from "./persistence/settings";
import { SyncService } from "./services/sync-service";
import { Syncer } from "./sync-operations/syncer";
import type { FileSystemOperations } from "./file-operations/filesystem-operations";
import { FileOperations } from "./file-operations/file-operations";
import { FetchController } from "./services/fetch-controller";
import { rateLimit } from "./utils/rate-limit";
import type { NetworkConnectionStatus } from "./types/network-connection-status";
import { DocumentSyncStatus } from "./types/document-sync-status";
import { WebSocketManager } from "./services/websocket-manager";
import { createClientId } from "./utils/create-client-id";
import { CursorTracker } from "./sync-operations/cursor-tracker";
import type { CursorSpan } from "./services/types/CursorSpan";
import type { MaybeOutdatedClientCursors } from "./types/maybe-outdated-client-cursors";
import { FileChangeNotifier } from "./sync-operations/file-change-notifier";
import { FixedSizeDocumentCache } from "./utils/data-structures/fix-sized-cache";
import { setUpTelemetry } from "./utils/set-up-telemetry";
import { DIFF_CACHE_SIZE_MB } from "./consts";
import { ServerConfig } from "./services/server-config";
import type { EventListeners } from "./utils/data-structures/event-listeners";
import { Lock } from "./utils/data-structures/locks";
import { ExpectedFsEvents } from "./sync-operations/expected-fs-events";

export class SyncClient {
    private hasFinishedOfflineSync = false;
    private hasStarted = false;
    private hasBeenDestroyed = false;
    private unloadTelemetry?: () => void;
    private isDestroying = false;
    private readonly eventUnsubscribers: (() => void)[] = [];
    private readonly settingsChangeLock = new Lock("SyncClient.onSettingsChange");

    private constructor(
        public readonly logger: Logger,
        private readonly history: SyncHistory,
        private readonly settings: Settings,
        private readonly syncEventQueue: SyncEventQueue,
        private readonly syncer: Syncer,
        private readonly webSocketManager: WebSocketManager,
        private readonly fetchController: FetchController,
        private readonly cursorTracker: CursorTracker,
        private readonly fileChangeNotifier: FileChangeNotifier,
        private readonly contentCache: FixedSizeDocumentCache,
        private readonly serverConfig: ServerConfig,
        private readonly syncService: SyncService,
        private readonly expectedFsEvents: ExpectedFsEvents,
        private readonly persistence: PersistenceProvider<
            Partial<{
                settings: Partial<SyncSettings>;
                database: Partial<StoredSyncState>;
            }>
        >
    ) { }

    public get syncedDocumentCount(): number {
        return this.syncEventQueue.syncedDocumentCount;
    }

    public get isWebSocketConnected(): boolean {
        return this.webSocketManager.isWebSocketConnected;
    }

    public get onSyncHistoryUpdated(): EventListeners<
        (stats: HistoryStats) => unknown
    > {
        this.checkIfDestroyed("onSyncHistoryUpdated getter");
        return this.history.onHistoryUpdated;
    }

    public get onSettingsChanged(): EventListeners<
        (newSettings: SyncSettings, oldSettings: SyncSettings) => unknown
    > {
        this.checkIfDestroyed("onSettingsChanged getter");
        return this.settings.onSettingsChanged;
    }

    public get onRemainingOperationsCountChanged(): EventListeners<
        (remainingOperationsCount: number) => unknown
    > {
        this.checkIfDestroyed("onRemainingOperationsCountChanged getter");
        return this.syncer.onRemainingOperationsCountChanged;
    }

    public get onWebSocketStatusChanged(): EventListeners<
        (isConnected: boolean) => unknown
    > {
        this.checkIfDestroyed("onWebSocketStatusChanged getter");
        return this.webSocketManager.onWebSocketStatusChanged;
    }

    public get onRemoteCursorsUpdated(): EventListeners<
        (cursors: MaybeOutdatedClientCursors[]) => unknown
    > {
        this.checkIfDestroyed("onRemoteCursorsUpdated getter");
        return this.cursorTracker.onRemoteCursorsUpdated;
    }

    public get hasPendingWork(): boolean {
        return (
            this.syncEventQueue.pendingUpdateCount > 0 ||
            this.webSocketManager.hasOutstandingWork
        );
    }

    public static async create({
        fs,
        persistence,
        fetch,
        webSocket,
        nativeLineEndings = "\n"
    }: {
        fs: FileSystemOperations;
        persistence: PersistenceProvider<
            Partial<{
                settings: Partial<SyncSettings>;
                database: Partial<StoredSyncState>;
            }>
        >;
        fetch?: typeof globalThis.fetch;
        webSocket?: typeof globalThis.WebSocket;
        nativeLineEndings?: string;
    }): Promise<SyncClient> {
        const logger = new Logger();

        const deviceId = createClientId();

        logger.info(`Creating SyncClient with client id ${deviceId}`);

        const history = new SyncHistory(logger);

        let state = (await persistence.load()) ?? {
            settings: undefined,
            database: undefined
        };

        const settings = new Settings(
            logger,
            state.settings,
            async (data): Promise<void> => {
                state = { ...state, settings: data };
                await persistence.save(state);
            }
        );

        const rateLimitedSave = rateLimit(
            persistence.save,
            () => settings.getSettings().minimumSaveIntervalMs
        );

        const syncEventQueue = new SyncEventQueue(
            settings,
            logger,
            state.database,
            async (data): Promise<void> => {
                state = { ...state, database: data };
                await rateLimitedSave(state);
            }
        );

        const fetchController = new FetchController(
            settings.getSettings().isSyncEnabled,
            logger
        );

        const syncService = new SyncService(
            deviceId,
            fetchController,
            settings,
            logger,
            fetch
        );

        const serverConfig = new ServerConfig(syncService);

        const expectedFsEvents = new ExpectedFsEvents();

        const fileOperations = new FileOperations(
            logger,
            fs,
            serverConfig,
            expectedFsEvents,
            nativeLineEndings
        );

        const contentCache = new FixedSizeDocumentCache(
            1024 * 1024 * DIFF_CACHE_SIZE_MB
        );

        const webSocketManager = new WebSocketManager(
            logger,
            settings,
            webSocket
        );

        const syncer = new Syncer(
            deviceId,
            logger,
            settings,
            webSocketManager,
            fileOperations,
            syncService,
            history,
            contentCache,
            serverConfig,
            syncEventQueue
        );

        const fileChangeNotifier = new FileChangeNotifier();
        const cursorTracker = new CursorTracker(
            logger,
            syncEventQueue,
            webSocketManager,
            fileOperations,
            fileChangeNotifier
        );
        const client = new SyncClient(
            logger,
            history,
            settings,
            syncEventQueue,
            syncer,
            webSocketManager,
            fetchController,
            cursorTracker,
            fileChangeNotifier,
            contentCache,
            serverConfig,
            syncService,
            expectedFsEvents,
            persistence
        );

        logger.info("SyncClient created successfully");

        return client;
    }

    public async start(): Promise<void> {
        this.checkIfDestroyed("start");

        if (this.hasStarted) {
            throw new Error("SyncClient has already been started");
        }
        this.hasStarted = true;

        if (
            !this.unloadTelemetry &&
            this.settings.getSettings().enableTelemetry
        ) {
            this.unloadTelemetry = setUpTelemetry();
        }

        this.eventUnsubscribers.push(
            this.settings.onSettingsChanged.add((newSettings, oldSettings) => {
                if (oldSettings.isSyncEnabled != newSettings.isSyncEnabled) {
                    this.fetchController.canFetch = newSettings.isSyncEnabled;
                }
            })
        );

        this.eventUnsubscribers.push(
            this.logger.onLogEmitted.add((log): void => {
                if (log.level === LogLevel.ERROR && Sentry.isInitialized()) {
                    Sentry.captureMessage(log.message);
                }
            })
        );

        this.eventUnsubscribers.push(
            this.settings.onSettingsChanged.add(
                this.onSettingsChange.bind(this)
            )
        );

        if (this.settings.getSettings().isSyncEnabled) {
            this.logger.info("Starting SyncClient");
            await this.startSyncing();
            this.logger.info("SyncClient has successfully started");
        }
    }

    /**
     * Reload settings from disk overriding current in-memory settings.
     * Missing values will be filled in from DEFAULT_SETTINGS rather than
     * retaining current in-memory settings.
     */
    public async reloadSettings(): Promise<void> {
        this.checkIfDestroyed("reloadSettings");

        const state = (await this.persistence.load()) ?? {
            settings: undefined
        };

        const settings = {
            ...DEFAULT_SETTINGS,
            ...(state.settings ?? {})
        };

        await this.setSettings(settings);
    }

    public async checkConnection(): Promise<NetworkConnectionStatus> {
        this.checkIfDestroyed("checkConnection");

        const server = await this.serverConfig.checkConnection(true);
        return {
            isSuccessful: server.isSuccessful,
            serverMessage: server.message,
            isWebSocketConnected: this.webSocketManager.isWebSocketConnected
        };
    }

    public getHistoryEntries(): readonly HistoryEntry[] {
        return this.history.entries;
    }

    /**
     * Wait for the in-flight operations to finish, reset all tracking,
     * and the local state but retain the settings.
     * The SyncClient can be used again after calling this method.
     */
    public async reset(): Promise<void> {
        this.checkIfDestroyed("reset");

        this.logger.info(
            "Stopping SyncClient to apply changed connection settings"
        );
        await this.pause();

        this.logger.info("Resetting SyncClient's local state");
        await this.syncEventQueue.clearAllState();
        await this.syncEventQueue.save();
        this.resetInMemoryState();
        this.hasFinishedOfflineSync = false;
        this.serverConfig.reset();

        if (this.settings.getSettings().isSyncEnabled) {
            await this.startSyncing();
        }
    }

    public getSettings(): SyncSettings {
        return this.settings.getSettings();
    }

    public async setSetting<T extends keyof SyncSettings>(
        key: T,
        value: SyncSettings[T]
    ): Promise<void> {
        this.checkIfDestroyed("setSetting");

        await this.settings.setSetting(key, value);
    }

    public async setSettings(value: Partial<SyncSettings>): Promise<void> {
        this.checkIfDestroyed("setSettings");

        await this.settings.setSettings(value);
    }

    public syncLocallyCreatedFile(relativePath: RelativePath): void {
        this.checkIfDestroyed("syncLocallyCreatedFile");

        this.fileChangeNotifier.notifyOfFileChange(relativePath); // this is for updating cursors
        if (this.expectedFsEvents.matchCreate(relativePath)) {
            return;
        }

        this.syncer.syncLocallyCreatedFile(relativePath);
    }

    public syncLocallyDeletedFile(relativePath: RelativePath): void {
        this.checkIfDestroyed("syncLocallyDeletedFile");

        this.fileChangeNotifier.notifyOfFileChange(relativePath); // this is for updating cursors
        if (this.expectedFsEvents.matchDelete(relativePath)) {
            return;
        }

        this.syncer.syncLocallyDeletedFile(relativePath);
    }

    public syncLocallyUpdatedFile({
        oldPath,
        relativePath
    }: {
        oldPath?: RelativePath;
        relativePath: RelativePath;
    }): void {
        this.checkIfDestroyed("syncLocallyUpdatedFile");

        this.fileChangeNotifier.notifyOfFileChange(relativePath); // this is for updating cursors
        if (this.expectedFsEvents.matchUpdate(relativePath, oldPath)) {
            return;
        }

        this.syncer.syncLocallyUpdatedFile({
            oldPath,
            relativePath
        });
    }

    public getDocumentSyncingStatus(
        relativePath: RelativePath
    ): DocumentSyncStatus {
        this.checkIfDestroyed("getDocumentSyncingStatus");

        if (!this.settings.getSettings().isSyncEnabled) {
            return DocumentSyncStatus.SYNCING_IS_DISABLED;
        }

        if (!this.hasFinishedOfflineSync) {
            return DocumentSyncStatus.SYNCING;
        }

        return this.syncEventQueue.hasPendingEventsForPath(relativePath)
            ? DocumentSyncStatus.SYNCING
            : DocumentSyncStatus.UP_TO_DATE;
    }

    public async updateLocalCursors(
        documentToCursors: Record<RelativePath, CursorSpan[]>
    ): Promise<void> {
        this.checkIfDestroyed("updateLocalCursors");

        await this.cursorTracker.sendLocalCursorsToServer(documentToCursors);
    }

    public async waitUntilFinished(): Promise<void> {
        this.checkIfDestroyed("waitUntilFinished");
        await this.waitUntilFinishedInternal();
    }

    /**
     * The actual drain — separated from `waitUntilFinished` so internal
     * shutdown paths (`pause` / `destroy`) can wait for in-flight work
     * without tripping the public `checkIfDestroyed` guard, which exists
     * only to keep external callers from continuing to use a disposed
     * client.
     */
    private async waitUntilFinishedInternal(): Promise<void> {
        await this.syncer.waitUntilFinished();
        await this.webSocketManager.waitUntilFinished();
        await this.syncEventQueue.save();
    }

    /**
     * Completely destroy the SyncClient, cancelling all in-progress operations.
     * After calling this method, the SyncClient cannot be used again.
     */
    public async destroy(): Promise<void> {
        if (this.hasBeenDestroyed) {
            throw new Error(
                "SyncClient has been destroyed and can no longer be used; called from destroy"
            );
        }
        if (this.isDestroying) {
            this.logger.warn(
                "destroy() called while already destroying, ignoring"
            );
            return;
        }
        this.isDestroying = true;

        // Run cleanup in `finally` so a thrown pause() — or anything else
        // mid-shutdown — still leaves the client in the disposed state
        // instead of bricked with subscribers/telemetry hanging on.
        try {
            await this.pause();
        } finally {
            this.hasBeenDestroyed = true;

            this.resetInMemoryState();

            this.eventUnsubscribers.forEach((unsubscribe) => {
                unsubscribe();
            });
            this.eventUnsubscribers.length = 0;

            this.logger.info("SyncClient has been successfully disposed");

            this.unloadTelemetry?.();
        }
    }

    private async startSyncing(): Promise<void> {
        this.checkIfDestroyed("startSyncing");
        this.fetchController.finishReset();
        // Undo any earlier `pause()` stop so retryForever keeps retrying.
        this.syncService.resume();

        await this.serverConfig.getConfig();

        await this.syncer.scheduleSyncForOfflineChanges();
        this.webSocketManager.start();

        this.hasFinishedOfflineSync = true;
    }

    private async pause(): Promise<void> {
        this.hasFinishedOfflineSync = false;
        this.fetchController.startReset();
        // Signal the service so any `retryForever` loop exits at its next
        // iteration instead of continuing to retry a network request while
        // the rest of the client is winding down.
        this.syncService.stop();
        await this.webSocketManager.stop();
        await this.waitUntilFinishedInternal();
        // Clear the offline-scan gate so a subsequent `startSyncing()`
        // re-runs the scan; otherwise any local changes made while sync was
        // paused (offline edits, deletes, renames) wouldn't be detected, and
        // an incoming remote update would silently overwrite them.
        this.syncer.clearOfflineScanGate();
        // Drop any expected fs events that were registered but never matched
        // (e.g. an op aborted by SyncResetError). Otherwise a real user edit
        // at the same path after re-enable would be swallowed.
        this.expectedFsEvents.clear();
    }

    private resetInMemoryState(): void {
        this.history.reset();
        this.contentCache.reset();
        this.cursorTracker.reset();
        this.syncer.reset();
    }

    private async onSettingsChange(
        newSettings: SyncSettings,
        oldSettings: SyncSettings
    ): Promise<void> {
        this.checkIfDestroyed("onSettingsChange");

        // Serialize listener invocations so back-to-back settings updates
        // can't run reset()/pause()/startSyncing() concurrently.
        await this.settingsChangeLock.withLock(async () => {
            // The lock is FIFO, so by the time we run the client may have
            // been destroyed in a queued invocation ahead of us.
            if (this.hasBeenDestroyed) {
                return;
            }

            const connectionChanged =
                newSettings.vaultName !== oldSettings.vaultName ||
                newSettings.remoteUri !== oldSettings.remoteUri;

            if (connectionChanged) {
                // reset() pauses, clears state, then starts iff isSyncEnabled
                // — so any concurrent isSyncEnabled change is already applied.
                await this.reset();
            } else if (newSettings.isSyncEnabled !== oldSettings.isSyncEnabled) {
                if (newSettings.isSyncEnabled) {
                    await this.startSyncing();
                } else {
                    await this.pause();
                }
            }

            if (newSettings.diffCacheSizeMB !== oldSettings.diffCacheSizeMB) {
                this.contentCache.resize(
                    newSettings.diffCacheSizeMB * 1024 * 1024
                );
            }

            if (newSettings.enableTelemetry !== oldSettings.enableTelemetry) {
                if (newSettings.enableTelemetry) {
                    this.unloadTelemetry = setUpTelemetry();
                } else {
                    this.unloadTelemetry?.();
                }
            }
        });
    }

    private checkIfDestroyed(origin: string): void {
        // Reject new public-API entries the moment destroy() is called,
        // not after `pause()` returns. Otherwise an external caller could
        // pass the guard and start mutating state while destroy() is
        // tearing down the websocket / clearing caches.
        if (this.hasBeenDestroyed || this.isDestroying) {
            throw new Error(
                `SyncClient has been destroyed and can no longer be used; called from ${origin}`
            );
        }
    }
}
