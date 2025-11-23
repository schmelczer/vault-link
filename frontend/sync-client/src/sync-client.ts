import type { PersistenceProvider } from "./persistence/persistence";
import type { HistoryEntry, HistoryStats } from "./tracing/sync-history";
import { SyncHistory } from "./tracing/sync-history";
import { Logger, LogLevel, LogLine } from "./tracing/logger";
import type { RelativePath, StoredDatabase } from "./persistence/database";
import { Database } from "./persistence/database";
import * as Sentry from "@sentry/browser";
import type { SyncSettings } from "./persistence/settings";
import { DEFAULT_SETTINGS, Settings } from "./persistence/settings";
import { SyncService } from "./services/sync-service";
import { Syncer } from "./sync-operations/syncer";
import type { FileSystemOperations } from "./file-operations/filesystem-operations";
import { FileOperations } from "./file-operations/file-operations";
import { FetchController } from "./services/fetch-controller";
import { UnrestrictedSyncer } from "./sync-operations/unrestricted-syncer";
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

export class SyncClient {
	private hasStartedOfflineSync = false;
	private hasFinishedOfflineSync = false;
	private hasStarted = false;
	private hasBeenDestroyed = false;
	private unloadTelemetry?: () => void;

	private constructor(
		private readonly history: SyncHistory,
		private readonly settings: Settings,
		private readonly database: Database,
		private readonly syncer: Syncer,
		private readonly syncService: SyncService,
		private readonly webSocketManager: WebSocketManager,
		public readonly logger: Logger,
		private readonly fetchController: FetchController,
		private readonly cursorTracker: CursorTracker,
		private readonly fileChangeNotifier: FileChangeNotifier,
		private readonly contentCache: FixedSizeDocumentCache,
		private readonly fileOperations: FileOperations,
		private readonly serverConfig: ServerConfig,
		private readonly persistence: PersistenceProvider<
			Partial<{
				settings: Partial<SyncSettings>;
				database: Partial<StoredDatabase>;
			}>
		>
	) {}

	public get documentCount(): number {
		this.checkIfDestroyed();

		return this.database.length;
	}

	public get isWebSocketConnected(): boolean {
		this.checkIfDestroyed();

		return this.webSocketManager.isWebSocketConnected;
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
				database: Partial<StoredDatabase>;
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
				// we're not rate-limiting settings saves as (1) we need to initialise the settings to know the rate limit
				// and (2) settings changes are infrequent enough that rate-limiting is not necessary
				await persistence.save(state);
			}
		);

		const rateLimitedSave = rateLimit(
			persistence.save,
			() => settings.getSettings().minimumSaveIntervalMs
		);

		const database = new Database(
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
		settings.addOnSettingsChangeListener((newSettings, oldSettings) => {
			if (oldSettings.isSyncEnabled != newSettings.isSyncEnabled) {
				fetchController.canFetch = newSettings.isSyncEnabled;
			}
		});

		const syncService = new SyncService(
			deviceId,
			fetchController,
			settings,
			logger,
			fetch
		);

		const serverConfig = new ServerConfig(syncService);

		const fileOperations = new FileOperations(
			logger,
			database,
			fs,
			serverConfig,
			nativeLineEndings
		);

		const contentCache = new FixedSizeDocumentCache(
			1024 * 1024 * DIFF_CACHE_SIZE_MB
		);
		const unrestrictedSyncer = new UnrestrictedSyncer(
			logger,
			database,
			settings,
			syncService,
			fileOperations,
			history,
			contentCache,
			serverConfig
		);

		const webSocketManager = new WebSocketManager(
			deviceId,
			logger,
			settings,
			webSocket
		);

		const syncer = new Syncer(
			deviceId,
			logger,
			database,
			settings,
			syncService,
			webSocketManager,
			fileOperations,
			unrestrictedSyncer
		);

		const fileChangeNotifier = new FileChangeNotifier();
		const cursorTracker = new CursorTracker(
			database,
			webSocketManager,
			fileOperations,
			fileChangeNotifier
		);
		const client = new SyncClient(
			history,
			settings,
			database,
			syncer,
			syncService,
			webSocketManager,
			logger,
			fetchController,
			cursorTracker,
			fileChangeNotifier,
			contentCache,
			fileOperations,
			serverConfig,
			persistence
		);

		logger.info("SyncClient created successfully");

		return client;
	}

	public async start(): Promise<void> {
		this.checkIfDestroyed();

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

		this.logger.addOnMessageListener((log): void => {
			if (log.level === LogLevel.ERROR && Sentry.isInitialized()) {
				Sentry.captureMessage(log.message);
			}
		});

		this.settings.addOnSettingsChangeListener(
			this.onSettingsChange.bind(this)
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
		this.checkIfDestroyed();

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
		this.checkIfDestroyed();

		const server = await this.serverConfig.checkConnection(true);
		return {
			isSuccessful: server.isSuccessful,
			serverMessage: server.message,
			isWebSocketConnected: this.webSocketManager.isWebSocketConnected
		};
	}

	public getHistoryEntries(): readonly HistoryEntry[] {
		this.checkIfDestroyed();

		return this.history.entries;
	}

	public addSyncHistoryUpdateListener(
		listener: (stats: HistoryStats) => unknown
	): void {
		this.checkIfDestroyed();

		this.history.addSyncHistoryUpdateListener(listener);
	}

	/**
	 * Wait for the in-flight operations to finish, reset all tracking,
	 * and the local database but retain the settings.
	 * The SyncClient can be used again after calling this method.
	 */
	public async applyChangedConnectionSettings(): Promise<void> {
		this.checkIfDestroyed();

		this.logger.info(
			"Stopping SyncClient to apply changed connection settings"
		);
		await this.pause();

		// clear all local state
		this.logger.info("Resetting SyncClient's local state");
		this.database.reset();
		await this.database.save(); // ensure the new database reads as empty
		this.resetInMemoryState();
		this.hasStartedOfflineSync = false;
		this.hasFinishedOfflineSync = false;
		this.serverConfig.reset();

		// restart syncing
		this.fetchController.finishReset();
		await this.startSyncing();
	}

	/**
	 * Completely destroy the SyncClient, cancelling all in-progress operations.
	 * After calling this method, the SyncClient cannot be used again.
	 */
	public async destroy(): Promise<void> {
		this.checkIfDestroyed();

		// cancel everything that's in progress
		this.fetchController.startReset();
		await this.pause();

		this.hasBeenDestroyed = true;

		// clean-up memory early
		this.resetInMemoryState();

		this.logger.info("SyncClient has been successfully disposed");

		this.unloadTelemetry?.();
	}

	public getSettings(): SyncSettings {
		this.checkIfDestroyed();

		return this.settings.getSettings();
	}

	public async setSetting<T extends keyof SyncSettings>(
		key: T,
		value: SyncSettings[T]
	): Promise<void> {
		this.checkIfDestroyed();

		await this.settings.setSetting(key, value);
	}

	public async setSettings(value: Partial<SyncSettings>): Promise<void> {
		this.checkIfDestroyed();

		await this.settings.setSettings(value);
	}

	public addOnSettingsChangeListener(
		listener: (settings: SyncSettings, oldSettings: SyncSettings) => unknown
	): void {
		this.checkIfDestroyed();

		this.settings.addOnSettingsChangeListener(listener);
	}

	public addRemainingSyncOperationsListener(
		listener: (remainingOperations: number) => unknown
	): void {
		this.checkIfDestroyed();

		this.syncer.addRemainingOperationsListener(listener);
	}

	public addWebSocketStatusChangeListener(listener: () => unknown): void {
		this.checkIfDestroyed();

		this.webSocketManager.addWebSocketStatusChangeListener(listener);
	}

	public async syncLocallyCreatedFile(
		relativePath: RelativePath
	): Promise<void> {
		this.checkIfDestroyed();

		this.fileChangeNotifier.notifyOfFileChange(relativePath);
		return this.syncer.syncLocallyCreatedFile(relativePath);
	}

	public async syncLocallyDeletedFile(
		relativePath: RelativePath
	): Promise<void> {
		this.checkIfDestroyed();

		this.fileChangeNotifier.notifyOfFileChange(relativePath);
		return this.syncer.syncLocallyDeletedFile(relativePath);
	}

	public async syncLocallyUpdatedFile({
		oldPath,
		relativePath
	}: {
		oldPath?: RelativePath;
		relativePath: RelativePath;
	}): Promise<void> {
		this.checkIfDestroyed();

		this.fileChangeNotifier.notifyOfFileChange(relativePath);
		return this.syncer.syncLocallyUpdatedFile({
			oldPath,
			relativePath
		});
	}

	public getDocumentSyncingStatus(
		relativePath: RelativePath
	): DocumentSyncStatus {
		this.checkIfDestroyed();

		if (!this.settings.getSettings().isSyncEnabled) {
			return DocumentSyncStatus.SYNCING_IS_DISABLED;
		}

		if (!this.syncer.isFirstSyncComplete || !this.hasFinishedOfflineSync) {
			return DocumentSyncStatus.SYNCING;
		}

		const document =
			this.database.getLatestDocumentByRelativePath(relativePath);
		if (document === undefined) {
			return DocumentSyncStatus.SYNCING;
		}
		return document.updates.length > 0
			? DocumentSyncStatus.SYNCING
			: DocumentSyncStatus.UP_TO_DATE;
	}

	public async updateLocalCursors(
		documentToCursors: Record<RelativePath, CursorSpan[]>
	): Promise<void> {
		this.checkIfDestroyed();

		await this.cursorTracker.sendLocalCursorsToServer(documentToCursors);
	}

	public addRemoteCursorsUpdateListener(
		listener: (cursors: MaybeOutdatedClientCursors[]) => unknown
	): void {
		this.checkIfDestroyed();

		this.cursorTracker.addRemoteCursorsUpdateListener(listener);
	}

	private async startSyncing(): Promise<void> {
		this.checkIfDestroyed();

		await this.serverConfig.initialize();

		if (!this.hasStartedOfflineSync) {
			this.hasStartedOfflineSync = true;
			await this.syncer.scheduleSyncForOfflineChanges();
		}

		this.hasFinishedOfflineSync = true;
		this.fetchController.finishReset();
		this.webSocketManager.start();
	}

	private async pause(): Promise<void> {
		this.fetchController.startReset();
		await this.webSocketManager.stop();
		await this.syncer.waitUntilFinished();
		await this.database.save(); // flush all changes to disk
	}

	private resetInMemoryState(): void {
		this.history.reset();
		this.contentCache.reset();
		this.logger.reset();
		this.cursorTracker.reset();
		this.syncer.reset();
		this.fileOperations.reset();
	}

	private async onSettingsChange(
		newSettings: SyncSettings,
		oldSettings: SyncSettings
	): Promise<void> {
		this.checkIfDestroyed();

		if (
			newSettings.vaultName !== oldSettings.vaultName ||
			newSettings.remoteUri !== oldSettings.remoteUri
		) {
			await this.applyChangedConnectionSettings();
		}

		if (newSettings.isSyncEnabled !== oldSettings.isSyncEnabled) {
			if (newSettings.isSyncEnabled) {
				await this.startSyncing();
			} else {
				await this.pause();
			}
		}

		if (newSettings.diffCacheSizeMB !== oldSettings.diffCacheSizeMB) {
			this.contentCache.resize(newSettings.diffCacheSizeMB * 1024 * 1024);
		}

		if (newSettings.enableTelemetry !== oldSettings.enableTelemetry) {
			if (newSettings.enableTelemetry) {
				this.unloadTelemetry = setUpTelemetry();
			} else {
				this.unloadTelemetry?.();
			}
		}
	}

	private checkIfDestroyed(): void {
		if (this.hasBeenDestroyed) {
			throw new Error(
				"SyncClient has been destroyed and can no longer be used."
			);
		}
	}
}
