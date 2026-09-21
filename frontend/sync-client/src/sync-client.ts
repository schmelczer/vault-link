import * as Sentry from "@sentry/browser";
import { setUpTelemetry } from "./utils/set-up-telemetry";
import type { PersistenceProvider } from "./persistence/persistence";
import { Database, type StoredDatabase } from "./persistence/database";
import {
    Settings,
    DEFAULT_SETTINGS,
    type SyncSettings
} from "./persistence/settings";
import type { FileSystemOperations } from "./file-operations/filesystem-operations";
import { FileOperations } from "./file-operations/file-operations";
import { Logger, LogLevel } from "./tracing/logger";
import { SyncHistory } from "./tracing/sync-history";
import { FetchController } from "./services/fetch-controller";
import { SyncService } from "./services/sync-service";
import { ServerConfig } from "./services/server-config";
import { WebSocketManager } from "./services/websocket-manager";
import { Syncer } from "./sync-operations/syncer";
import { CursorTracker } from "./sync-operations/cursor-tracker";
import { FileChangeNotifier } from "./sync-operations/file-change-notifier";
import { createClientId } from "./utils/create-client-id";
import { DocumentSyncStatus } from "./types/document-sync-status";
import type { CursorSpan } from "./services/types/CursorSpan";
import { isInternalPath } from "./utils/portable-path";
import { FixedSizeDocumentCache } from "./utils/data-structures/fix-sized-cache";
import { globsToRegexes } from "./utils/globs-to-regexes";
import { Lock } from "./utils/data-structures/locks";
import type { LocalChange } from "./sync-operations/local-changes";

type StoredClient = Partial<{
    settings: Partial<SyncSettings>;
    database: Partial<StoredDatabase>;
    localChanges: LocalChange[];
    localChangesVaultKey: string;
    historyCheckpoint: { vaultKey: string; checkpoint?: string };
}>;

const vaultKey = (settings: SyncSettings): string =>
    JSON.stringify([
        settings.remoteUri.replace(/\/$/u, ""),
        settings.vaultName
    ]);

export class SyncClient {
    private readonly lifecycle = new Lock();
    private destroying?: Promise<void>;
    private started = false;
    private destroyed = false;
    private unloadTelemetry?: () => void;
    private readonly unsubscribeLog: () => void;
    private constructor(
        public readonly logger: Logger,
        private readonly history: SyncHistory,
        private readonly settings: Settings,
        private readonly database: Database,
        private readonly syncer: Syncer,
        private readonly webSocketManager: WebSocketManager,
        private readonly fetchController: FetchController,
        private readonly serverConfig: ServerConfig,
        private readonly cursorTracker: CursorTracker,
        private readonly fileChangeNotifier: FileChangeNotifier,
        private readonly contentCache: FixedSizeDocumentCache,
        private readonly persistence: PersistenceProvider<StoredClient>
    ) {
        syncer.onServerHistoryChanged.add(() => {
            cursorTracker.reset();
        });
        syncer.onReadyForEvents.add(() => {
            if (
                this.started &&
                !this.destroyed &&
                settings.getSettings().isSyncEnabled
            )
                webSocketManager.start();
        });
        this.unsubscribeLog = logger.onLogEmitted.add((log) => {
            if (log.level === LogLevel.ERROR && Sentry.isInitialized())
                Sentry.captureMessage(log.message);
        });
    }

    public static async create({
        fs,
        persistence,
        fetch,
        webSocket
    }: {
        fs: FileSystemOperations;
        persistence: PersistenceProvider<StoredClient>;
        fetch?: typeof globalThis.fetch;
        webSocket?: typeof globalThis.WebSocket;
        /** V4 preserves bytes and line endings as stored, on every platform. */
        nativeLineEndings?: string;
    }): Promise<SyncClient> {
        const logger = new Logger();
        let stored = (await persistence.load()) ?? {};
        let saving: Promise<void> = Promise.resolve();
        let reloadBeforeSave = false;
        // Settings and engine state share a store. Serialize complete durable
        // replacements so one cannot overwrite a newer save from the other.
        const save = async (update: StoredClient): Promise<void> => {
            const operation = saving.then(async () => {
                if (reloadBeforeSave) {
                    stored = (await persistence.load()) ?? {};
                    reloadBeforeSave = false;
                }
                const next = { ...stored, ...structuredClone(update) };
                try {
                    await persistence.save(next);
                    stored = next;
                } catch (error) {
                    // A failed save may have committed. Do not let a queued
                    // settings/notification save roll back that engine state.
                    reloadBeforeSave = true;
                    throw error;
                }
            });
            saving = operation.catch(() => {});
            return operation;
        };
        const settings = new Settings(logger, stored.settings, async (data) =>
            save({ settings: data })
        );
        const database = new Database(
            logger,
            stored.database,
            async (data) => save({ database: data }),
            vaultKey(settings.getSettings()),
            async () => {
                await saving;
                stored = (await persistence.load()) ?? {};
                return stored.database as StoredDatabase | undefined;
            }
        );
        if (
            stored.localChanges?.length &&
            stored.localChangesVaultKey !== vaultKey(settings.getSettings())
        ) {
            throw new Error(
                "Offline notifications belong to another vault; use a separate state store"
            );
        }
        const fetchController = new FetchController(
            settings.getSettings().isSyncEnabled,
            logger
        );
        const deviceId = createClientId();
        const service = new SyncService(
            deviceId,
            fetchController,
            settings,
            logger,
            fetch,
            {
                get: () =>
                    stored.historyCheckpoint?.vaultKey ===
                    vaultKey(settings.getSettings())
                        ? stored.historyCheckpoint.checkpoint
                        : undefined,
                save: async (checkpoint) =>
                    save({
                        historyCheckpoint: {
                            vaultKey: vaultKey(settings.getSettings()),
                            checkpoint
                        }
                    })
            }
        );
        const serverConfig = new ServerConfig(service);
        const notifier = new FileChangeNotifier();
        const localChanges = stored.localChanges ?? [];
        let syncer: Syncer;
        const files = new FileOperations(
            fs,
            database,
            serverConfig,
            (paths) => {
                for (const path of paths) notifier.notifyOfFileChange(path);
            },
            {
                entries: () => localChanges,
                flush: async () => syncer?.flushLocalChanges()
            },
            (path, size) => {
                const current = settings.getSettings();
                return (
                    size > current.maxFileSizeMB * 1024 * 1024 ||
                    globsToRegexes(current.ignorePatterns, logger).some(
                        (pattern) => pattern.test(path)
                    )
                );
            }
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
        syncer = new Syncer(
            deviceId,
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
                        localChangesVaultKey: vaultKey(settings.getSettings())
                    })
            }
        );
        const cursors = new CursorTracker(database, websocket, files, notifier);
        return new SyncClient(
            logger,
            history,
            settings,
            database,
            syncer,
            websocket,
            fetchController,
            serverConfig,
            cursors,
            notifier,
            contentCache,
            persistence
        );
    }

    private check(): void {
        if (this.destroyed) throw new Error("SyncClient has been destroyed");
    }

    public get documentCount(): number {
        return this.database.length;
    }

    public get isWebSocketConnected(): boolean {
        return this.webSocketManager.isWebSocketConnected;
    }

    public get onSyncHistoryUpdated() {
        return this.history.onHistoryUpdated;
    }

    public get onSettingsChanged() {
        return this.settings.onSettingsChanged;
    }

    public get onRemainingOperationsCountChanged() {
        return this.syncer.onRemainingOperationsCountChanged;
    }

    public get onWebSocketStatusChanged() {
        return this.webSocketManager.onWebSocketStatusChanged;
    }

    public get onRemoteCursorsUpdated() {
        return this.cursorTracker.onRemoteCursorsUpdated;
    }

    public getHistoryEntries() {
        return this.history.entries;
    }

    public getSettings(): SyncSettings {
        return this.settings.getSettings();
    }

    public async start(): Promise<void> {
        await this.lifecycle.withLock(async () => {
            this.check();
            if (this.started)
                throw new Error("SyncClient has already been started");
            await this.syncer.recoverLocalState();
            await this.database.bindVault(
                vaultKey(this.settings.getSettings())
            );
            this.started = true;
            this.configureTelemetry();
            if (this.settings.getSettings().isSyncEnabled) await this.resume();
        });
    }

    private async resume(): Promise<void> {
        if (this.destroyed) return;
        if (!this.settings.getSettings().isSyncEnabled) return;
        await this.database.bindVault(vaultKey(this.settings.getSettings()));
        this.fetchController.finishReset();
        this.fetchController.canFetch = true;
        this.syncer.start();
        await this.syncer.waitUntilFinished();
    }

    private async pause(): Promise<void> {
        const stopped = this.syncer.stop();
        this.fetchController.startReset();
        await this.webSocketManager.stop();
        await stopped;
    }

    /** Restart transports; never discard pending requests or filesystem journals. */
    public async reset(): Promise<void> {
        await this.lifecycle.withLock(async () => {
            this.check();
            await this.pause();
            this.serverConfig.reset();
            this.cursorTracker.reset();
            await this.syncer.retryRejectedRequests();
            if (this.started && this.settings.getSettings().isSyncEnabled)
                await this.resume();
        });
    }

    public async setSettings(change: Partial<SyncSettings>): Promise<void> {
        const update = structuredClone(change);
        const notification = await this.lifecycle.withLock(async () => {
            this.check();
            const old = this.settings.getSettings();
            const next = { ...old, ...update };
            if (
                vaultKey(next) !== vaultKey(old) &&
                (this.started ||
                    this.database.state.initialized ||
                    this.database.state.bootstrap ||
                    this.database.state.pending ||
                    this.database.state.application ||
                    this.syncer.hasLocalChanges ||
                    Object.keys(this.database.state.local).length)
            )
                throw new Error(
                    "Changing vaults requires a separate state store and client; pending recovery data must not be reset"
                );

            try {
                if (this.started) await this.pause();
                await this.database.recoverPersistence();
                await this.settings.setSettings(update, false);
                await this.syncer.retryRejectedRequests();
                this.contentCache.resize(next.diffCacheSizeMB * 1024 * 1024);
                await this.database.bindVault(vaultKey(next));
            } catch (error) {
                this.serverConfig.reset();
                this.contentCache.resize(
                    this.settings.getSettings().diffCacheSizeMB * 1024 * 1024
                );
                this.configureTelemetry();
                if (this.started && this.settings.getSettings().isSyncEnabled)
                    await this.resume().catch((resumeError: unknown) => {
                        this.logger.error(
                            `Settings recovery could not resume sync: ${String(resumeError)}`
                        );
                    });
                throw error;
            }
            this.serverConfig.reset();
            this.configureTelemetry();
            if (this.started && next.isSyncEnabled) await this.resume();
            return [this.settings.getSettings(), old] as const;
        });
        await this.settings.onSettingsChanged.triggerAsync(...notification);
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

    public async checkConnection() {
        const result = await this.serverConfig.checkConnection(true);
        return {
            isSuccessful: result.isSuccessful,
            serverMessage: result.message,
            isWebSocketConnected: this.isWebSocketConnected
        };
    }

    /** Notifications enqueue work. Use waitUntilFinished() to await convergence. */
    public async syncLocallyCreatedFile(path: string): Promise<void> {
        this.check();
        if (isInternalPath(path)) return;
        this.fileChangeNotifier.notifyOfFileChange(path);
        await this.syncer.syncLocallyCreatedFile(path);
    }

    public async syncLocallyDeletedFile(path: string): Promise<void> {
        this.check();
        if (isInternalPath(path)) return;
        this.fileChangeNotifier.notifyOfFileChange(path);
        await this.syncer.syncLocallyDeletedFile(path);
    }

    public async syncLocallyUpdatedFile(change: {
        oldPath?: string;
        relativePath: string;
    }): Promise<void> {
        this.check();
        if (
            isInternalPath(change.relativePath) ||
            (change.oldPath && isInternalPath(change.oldPath))
        )
            return;
        this.fileChangeNotifier.notifyOfFileChange(change.relativePath);
        await this.syncer.syncLocallyUpdatedFile(change);
    }

    public async updateLocalCursors(
        cursors: Record<string, CursorSpan[]>
    ): Promise<void> {
        this.check();
        await this.cursorTracker.sendLocalCursorsToServer(cursors);
    }

    public getDocumentSyncingStatus(path: string): DocumentSyncStatus {
        this.check();
        if (!this.settings.getSettings().isSyncEnabled)
            return DocumentSyncStatus.SYNCING_IS_DISABLED;
        return this.syncer.isDocumentUpToDate(path)
            ? DocumentSyncStatus.UP_TO_DATE
            : DocumentSyncStatus.SYNCING;
    }

    public async waitUntilFinished(): Promise<void> {
        this.check();
        await this.syncer.waitUntilFinished();
    }

    private configureTelemetry(): void {
        if (
            this.settings.getSettings().enableTelemetry &&
            typeof window !== "undefined"
        ) {
            this.unloadTelemetry ??= setUpTelemetry();
        } else {
            this.unloadTelemetry?.();
            this.unloadTelemetry = undefined;
        }
    }

    public async destroy(): Promise<void> {
        if (this.destroying) return this.destroying;
        this.destroyed = true;
        // Interrupt a start/reset awaiting network progress before waiting for
        // its lifecycle operation to finish.
        this.fetchController.startReset();
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
}
