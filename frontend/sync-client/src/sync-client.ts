import type { NetworkConnectionStatus } from "./types/network-connection-status";
import { ClientMetadataStore } from "./persistence/client-metadata-store";
import * as Sentry from "@sentry/browser";
import { setUpTelemetry } from "./utils/set-up-telemetry";
import type {
    MetadataPersistenceProvider,
    StoredClient
} from "./persistence/metadata-persistence-provider";
import { Database, type RelativePath } from "./persistence/database";
import {
    Settings,
    DEFAULT_SETTINGS,
    type SyncSettings
} from "./persistence/settings";
import type { FileSystemOperations } from "./file-operations/filesystem-operations";
import { FileOperations } from "./file-operations/file-operations";
import { Logger, LogLevel } from "./tracing/logger";
import { SyncHistory } from "./tracing/sync-history";
import { SyncService } from "./services/sync-service";
import { ServerConfig } from "./services/server-config";
import { WebSocketManager } from "./services/websocket-manager";
import { Syncer } from "./sync-operations/syncer";
import { CursorTracker } from "./sync-operations/cursor-tracker";
import { EventListeners } from "./utils/data-structures/event-listeners";
import { createClientId } from "./utils/create-client-id";
import { ClientPhase } from "./types/client-phase";
import { DocumentSyncStatus } from "./types/document-sync-status";
import type { CursorSpan } from "./services/types/CursorSpan";
import { isInternalPath } from "./utils/portable-path";
import { FixedSizeDocumentCache } from "./utils/data-structures/fix-sized-cache";
import { Lock } from "./utils/data-structures/locks";
import { getUnappliedChanges } from "./sync-operations/local-changes";

export class SyncClient {
    private readonly lifecycle = new Lock();
    private destroying?: Promise<void>;
    private phase = ClientPhase.Created;
    private unloadTelemetry?: () => void;
    private readonly unsubscribeLog: () => void;

    private constructor(
        public readonly logger: Logger,
        private readonly history: SyncHistory,
        private readonly settingsStore: Settings,
        private readonly database: Database,
        private readonly syncer: Syncer,
        private readonly webSocketManager: WebSocketManager,
        private readonly service: SyncService,
        private readonly serverConfig: ServerConfig,
        private readonly cursorTracker: CursorTracker,
        private readonly fileChanges: EventListeners<
            (path: RelativePath) => unknown
        >,
        private readonly contentCache: FixedSizeDocumentCache,
        private readonly persistence: MetadataPersistenceProvider
    ) {
        syncer.onServerHistoryChanged.add(() => {
            cursorTracker.reset();
        });

        syncer.onReadyForEvents.add(() => {
            if (
                this.phase === ClientPhase.Started &&
                settingsStore.getSettings().isSyncEnabled
            ) {
                webSocketManager.start();
            }
        });

        this.unsubscribeLog = logger.onLogEmitted.add((log) => {
            if (log.level === LogLevel.ERROR && Sentry.isInitialized()) {
                Sentry.captureMessage(log.message);
            }
        });
    }

    public get documentCount(): number {
        return this.database.length;
    }

    public get isWebSocketConnected(): boolean {
        return this.webSocketManager.isWebSocketConnected;
    }

    public get onSyncHistoryUpdated(): SyncHistory["onHistoryUpdated"] {
        return this.history.onHistoryUpdated;
    }

    public get onSettingsChanged(): Settings["onSettingsChanged"] {
        return this.settingsStore.onSettingsChanged;
    }

    public get onRemainingOperationsCountChanged(): Syncer["onRemainingOperationsCountChanged"] {
        return this.syncer.onRemainingOperationsCountChanged;
    }

    public get onWebSocketStatusChanged(): WebSocketManager["onWebSocketStatusChanged"] {
        return this.webSocketManager.onWebSocketStatusChanged;
    }

    public get onRemoteCursorsUpdated(): CursorTracker["onRemoteCursorsUpdated"] {
        return this.cursorTracker.onRemoteCursorsUpdated;
    }

    public get historyEntries(): SyncHistory["entries"] {
        return this.history.entries;
    }

    public get settings(): SyncSettings {
        return this.settingsStore.getSettings();
    }

    public static async create({
        fs,
        persistence,
        fetch,
        webSocket
    }: {
        fs: FileSystemOperations;
        persistence: MetadataPersistenceProvider;
        fetch?: typeof globalThis.fetch;
        webSocket?: typeof globalThis.WebSocket;
    }): Promise<SyncClient> {
        const logger = new Logger();
        const metadata = await ClientMetadataStore.load(persistence);
        const { stored } = metadata;

        const save = async (update: StoredClient): Promise<void> =>
            metadata.save(update);

        const settings = new Settings(logger, stored.settings, async (data) =>
            save({ settings: data })
        );

        const database = new Database(
            stored.database,
            SyncClient.getVaultKey(settings.getSettings()),
            async (data) => save({ database: data }),
            async () => metadata.reloadDatabase()
        );

        const localChanges = getUnappliedChanges(
            database.state,
            stored.localChanges ?? []
        );

        if (
            localChanges.length &&
            stored.localChangesVaultKey !==
            SyncClient.getVaultKey(settings.getSettings())
        ) {
            throw new Error(
                "Offline notifications belong to another vault; use a separate state store"
            );
        }

        const deviceId = createClientId();
        const service = new SyncService(deviceId, settings, fetch, {
            get: (): string | undefined =>
                metadata.stored.historyCheckpoint?.vaultKey ===
                    SyncClient.getVaultKey(settings.getSettings())
                    ? metadata.stored.historyCheckpoint.checkpoint
                    : undefined,
            save: async (checkpoint): Promise<void> =>
                save({
                    historyCheckpoint: {
                        vaultKey: SyncClient.getVaultKey(
                            settings.getSettings()
                        ),
                        checkpoint
                    }
                })
        });

        const serverConfig = new ServerConfig(service);

        const notifier = new EventListeners<(path: RelativePath) => unknown>();

        const files = new FileOperations(
            fs,
            database,
            serverConfig,
            (paths) => {
                for (const path of paths) {
                    notifier.trigger(path);
                }
            },
            {
                entries: localChanges,
                // Invoked after all components have been constructed.
                // eslint-disable-next-line @typescript-eslint/no-use-before-define
                flush: async (): Promise<void> => syncer.flushLocalChanges()
            },
            (path, size) =>
                settings.isIgnored(path) || settings.isOversized(size)
        );

        const websocket = new WebSocketManager(
            deviceId,
            logger,
            settings,
            webSocket
        );

        const history = new SyncHistory(logger);

        const contentCache = new FixedSizeDocumentCache(
            settings.getSettings().diffCacheSizeMB * 1024 * 1024
        );

        const syncer: Syncer = new Syncer(
            logger,
            database,
            settings,
            service,
            websocket,
            files,
            serverConfig,
            history,
            contentCache,
            {
                entries: localChanges,
                save: async (entries) =>
                    save({
                        localChanges: entries,
                        localChangesVaultKey: SyncClient.getVaultKey(
                            settings.getSettings()
                        )
                    })
            }
        );

        const cursors = new CursorTracker(database, websocket, fs, notifier);

        return new SyncClient(
            logger,
            history,
            settings,
            database,
            syncer,
            websocket,
            service,
            serverConfig,
            cursors,
            notifier,
            contentCache,
            persistence
        );
    }

    private static getVaultKey(settings: SyncSettings): string {
        return JSON.stringify([
            settings.remoteUri.replace(/\/$/u, ""),
            settings.vaultName
        ]);
    }

    public async start(): Promise<void> {
        await this.lifecycle.withLock(async () => {
            this.assertNotDestroyed();
            if (this.phase === ClientPhase.Started) {
                throw new Error("SyncClient has already been started");
            }

            await this.syncer.reloadLocalState();

            await this.database.bindVault(
                SyncClient.getVaultKey(this.settingsStore.getSettings())
            );

            // destroy() can interrupt the metadata work above before acquiring
            // the lifecycle lock. Its terminal state must not be overwritten.
            if (this.phase === ClientPhase.Destroyed) {
                return;
            }

            this.phase = ClientPhase.Started;
            this.configureTelemetry();
            await this.resume();
        });
    }

    // Restart transports; never discard pending requests.
    public async reset(): Promise<void> {
        await this.lifecycle.withLock(async () => {
            this.assertNotDestroyed();
            await this.pause();
            this.serverConfig.reset();
            this.cursorTracker.reset();
            await this.syncer.retryRejectedRequests();
            await this.resume();
        });
    }

    public async setSettings(change: Partial<SyncSettings>): Promise<void> {
        const update = structuredClone(change);

        const notification = await this.lifecycle.withLock(async () => {
            this.assertNotDestroyed();
            const old = this.settingsStore.getSettings();
            const next = { ...old, ...update };
            if (
                SyncClient.getVaultKey(next) !== SyncClient.getVaultKey(old) &&
                (this.phase === ClientPhase.Started ||
                    this.database.state.lastSeenUpdateId !== undefined ||
                    this.database.state.pending ||
                    this.syncer.hasLocalChanges ||
                    Object.keys(this.database.state.actualFileManifest).length)
            ) {
                throw new Error(
                    "Changing vaults requires a separate state store and client; existing sync state must not be reset"
                );
            }

            try {
                if (this.phase === ClientPhase.Started) {
                    await this.pause();
                }

                await this.database.reloadFromSave();
                await this.settingsStore.setSettings(update, false);
                await this.syncer.retryRejectedRequests();
                this.contentCache.resize(next.diffCacheSizeMB * 1024 * 1024);
                await this.database.bindVault(SyncClient.getVaultKey(next));
            } catch (error) {
                this.serverConfig.reset();
                this.contentCache.resize(
                    this.settingsStore.getSettings().diffCacheSizeMB *
                    1024 *
                    1024
                );
                this.configureTelemetry();
                await this.resume().catch((resumeError: unknown) => {
                    this.logger.error(
                        `Settings recovery could not resume sync: ${String(resumeError)}`
                    );
                });
                throw error;
            }

            this.serverConfig.reset();
            this.configureTelemetry();
            await this.resume();
            return [this.settingsStore.getSettings(), old] as const;
        });
        await this.settingsStore.onSettingsChanged.triggerAsync(
            ...notification
        );
    }

    public async setSetting<K extends keyof SyncSettings>(
        key: K,
        value: SyncSettings[K]
    ): Promise<void> {
        await this.setSettings({ [key]: value });
    }

    public async reloadSettings(): Promise<void> {
        const stored = await this.persistence.load();
        await this.setSettings({ ...DEFAULT_SETTINGS, ...stored?.settings });
    }

    public async checkConnection(): Promise<NetworkConnectionStatus> {
        const result = await this.serverConfig.checkConnection();
        return {
            isSuccessful: result.isSuccessful,
            serverMessage: result.message,
            isWebSocketConnected: this.isWebSocketConnected
        };
    }

    // Notifications enqueue work. Use waitUntilFinished() to await convergence.
    public async syncLocallyCreatedFile(path: RelativePath): Promise<void> {
        this.assertNotDestroyed();
        if (isInternalPath(path)) {
            return;
        }

        this.fileChanges.trigger(path);
        await this.syncer.syncLocallyCreatedFile(path);
    }

    public async syncLocallyDeletedFile(path: RelativePath): Promise<void> {
        this.assertNotDestroyed();
        if (isInternalPath(path)) {
            return;
        }

        this.fileChanges.trigger(path);
        await this.syncer.syncLocallyDeletedFile(path);
    }

    public async syncLocallyUpdatedFile(change: {
        oldPath?: RelativePath;
        relativePath: RelativePath;
    }): Promise<void> {
        this.assertNotDestroyed();
        if (
            isInternalPath(change.relativePath) ||
            (change.oldPath !== undefined &&
                change.oldPath !== "" &&
                isInternalPath(change.oldPath))
        ) {
            return;
        }

        this.fileChanges.trigger(change.relativePath);
        await this.syncer.syncLocallyUpdatedFile(change);
    }

    public async updateLocalCursors(
        cursors: Record<RelativePath, CursorSpan[]>
    ): Promise<void> {
        this.assertNotDestroyed();
        await this.cursorTracker.sendLocalCursorsToServer(cursors);
    }

    public getDocumentSyncingStatus(path: RelativePath): DocumentSyncStatus {
        this.assertNotDestroyed();
        if (!this.settingsStore.getSettings().isSyncEnabled) {
            return DocumentSyncStatus.SYNCING_IS_DISABLED;
        }

        return this.syncer.isDocumentUpToDate(path)
            ? DocumentSyncStatus.UP_TO_DATE
            : DocumentSyncStatus.SYNCING;
    }

    public async waitUntilFinished(): Promise<void> {
        this.assertNotDestroyed();
        await this.syncer.waitUntilFinished();
    }

    public async destroy(): Promise<void> {
        if (this.destroying) {
            return this.destroying;
        }

        this.phase = ClientPhase.Destroyed;
        // Interrupt a start/reset awaiting network progress before waiting for
        // its lifecycle operation to finish.
        this.service.pause();
        const stopped = this.syncer.stop();
        this.destroying = this.lifecycle.withLock(async () => {
            try {
                await this.webSocketManager.stop();
                await stopped;
                await this.syncer.flushLocalChanges();
            } finally {
                this.cursorTracker.reset();
                this.unsubscribeLog();
                this.unloadTelemetry?.();
            }
        });
        return this.destroying;
    }

    private assertNotDestroyed(): void {
        if (this.phase === ClientPhase.Destroyed) {
            throw new Error("SyncClient has been destroyed");
        }
    }

    private async resume(): Promise<void> {
        if (
            this.phase !== ClientPhase.Started ||
            !this.settingsStore.getSettings().isSyncEnabled
        ) {
            return;
        }

        await this.database.bindVault(
            SyncClient.getVaultKey(this.settingsStore.getSettings())
        );
        this.service.resume();
        this.syncer.start();
        await this.syncer.waitUntilFinished();
    }

    private async pause(): Promise<void> {
        const stopped = this.syncer.stop();
        this.service.pause();
        await this.webSocketManager.stop();
        await stopped;
    }

    private configureTelemetry(): void {
        if (
            this.settingsStore.getSettings().enableTelemetry &&
            typeof window !== "undefined"
        ) {
            this.unloadTelemetry ??= setUpTelemetry();
        } else {
            this.unloadTelemetry?.();
            this.unloadTelemetry = undefined;
        }
    }
}
