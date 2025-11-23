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
import { DIFF_CACHE_SIZE_MB, MINIMUM_SAVE_INTERVAL_MS } from "./consts";

export class SyncClient {
	private hasStartedOfflineSync = false;
	private hasFinishedOfflineSync = false;
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
		private readonly persistence: PersistenceProvider<
			Partial<{
				settings: Partial<SyncSettings>;
				database: Partial<StoredDatabase>;
			}>
		>
	) {}

	public async start(): Promise<void> {
		if (this.settings.getSettings().enableTelemetry) {
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

	// Reload settings from disk overriding current in-memory settings.
	// Missing values will be filled in from DEFAULT_SETTINGS rather than
	// retaining current in-memory settings.
	public async reloadSettings(): Promise<void> {
		let state = (await this.persistence.load()) ?? {
			settings: undefined
		};

		const settings = {
			...DEFAULT_SETTINGS,
			...(state.settings ?? {})
		};

		this.setSettings(settings);
	}

	private async onSettingsChange(
		newSettings: SyncSettings,
		oldSettings: SyncSettings
	): Promise<void> {
		if (newSettings.vaultName !== oldSettings.vaultName) {
			await this.reset();
		}

		if (newSettings.isSyncEnabled !== oldSettings.isSyncEnabled) {
			if (newSettings.isSyncEnabled) {
				await this.startSyncing();
			} else {
				this.stop();
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

	public get documentCount(): number {
		return this.database.length;
	}

	public get isWebSocketConnected(): boolean {
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

		const rateLimitedSave = rateLimit(
			persistence.save,
			MINIMUM_SAVE_INTERVAL_MS
		);

		const database = new Database(
			logger,
			state.database,
			async (data): Promise<void> => {
				state = { ...state, database: data };
				await rateLimitedSave(state);
			}
		);

		const settings = new Settings(
			logger,
			state.settings,
			async (data): Promise<void> => {
				state = { ...state, settings: data };
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

		const fileOperations = new FileOperations(
			logger,
			database,
			fs,
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
			contentCache
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
			persistence
		);

		logger.info("SyncClient created successfully");

		return client;
	}

	public async checkConnection(): Promise<NetworkConnectionStatus> {
		const server = await this.syncService.checkConnection();
		return {
			isSuccessful: server.isSuccessful,
			serverMessage: server.message,
			isWebSocketConnected: this.webSocketManager.isWebSocketConnected
		};
	}

	public getHistoryEntries(): readonly HistoryEntry[] {
		return this.history.entries;
	}

	public addSyncHistoryUpdateListener(
		listener: (stats: HistoryStats) => unknown
	): void {
		this.history.addSyncHistoryUpdateListener(listener);
	}

	private async startSyncing(): Promise<void> {
		if (!this.hasStartedOfflineSync) {
			this.hasStartedOfflineSync = true;
			await this.syncer.scheduleSyncForOfflineChanges();
		}

		this.hasFinishedOfflineSync = true;
		this.webSocketManager.start();
	}

	private stop(): void {
		this.hasFinishedOfflineSync = false;
		this.webSocketManager.stop();

		this.unloadTelemetry?.();
	}

	public async waitUntilStopped(): Promise<void> {
		await this.syncer.waitUntilFinished();
	}

	public async applyChangedConnectionSettings(): Promise<void> {
		this.fetchController.startReset();
		this.webSocketManager.stop();

		this.webSocketManager.start();
		this.fetchController.finishReset();
	}

	/// Wait for the in-flight operations to finish, reset all tracking,
	/// and the local database but retain the settings.
	/// The SyncClient can be used again after calling this method.
	private async reset(): Promise<void> {
		this.stop();
		this.fetchController.startReset();
		this.contentCache.clear();
		await this.syncer.reset();
		this.history.reset();
		this.database.reset();
		this.logger.reset();
		this.fetchController.finishReset();
		await this.startSyncing();
	}

	public getSettings(): SyncSettings {
		return this.settings.getSettings();
	}

	public async setSetting<T extends keyof SyncSettings>(
		key: T,
		value: SyncSettings[T]
	): Promise<void> {
		await this.settings.setSetting(key, value);
	}

	public async setSettings(value: Partial<SyncSettings>): Promise<void> {
		await this.settings.setSettings(value);
	}

	public addOnSettingsChangeListener(
		listener: (settings: SyncSettings, oldSettings: SyncSettings) => unknown
	): void {
		this.settings.addOnSettingsChangeListener(listener);
	}

	public addRemainingSyncOperationsListener(
		listener: (remainingOperations: number) => unknown
	): void {
		this.syncer.addRemainingOperationsListener(listener);
	}

	public addWebSocketStatusChangeListener(listener: () => unknown): void {
		this.webSocketManager.addWebSocketStatusChangeListener(listener);
	}

	public async syncLocallyCreatedFile(
		relativePath: RelativePath
	): Promise<void> {
		this.fileChangeNotifier.notifyOfFileChange(relativePath);
		return this.syncer.syncLocallyCreatedFile(relativePath);
	}

	public async syncLocallyDeletedFile(
		relativePath: RelativePath
	): Promise<void> {
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
		this.fileChangeNotifier.notifyOfFileChange(relativePath);
		return this.syncer.syncLocallyUpdatedFile({
			oldPath,
			relativePath
		});
	}

	public getDocumentSyncingStatus(
		relativePath: RelativePath
	): DocumentSyncStatus {
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
		await this.cursorTracker.sendLocalCursorsToServer(documentToCursors);
	}

	public addRemoteCursorsUpdateListener(
		listener: (cursors: MaybeOutdatedClientCursors[]) => unknown
	): void {
		this.cursorTracker.addRemoteCursorsUpdateListener(listener);
	}
}
