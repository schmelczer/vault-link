import type { PersistenceProvider } from "./persistence/persistence";
import type { HistoryEntry, HistoryStats } from "./tracing/sync-history";
import { SyncHistory } from "./tracing/sync-history";
import { Logger } from "./tracing/logger";
import type { RelativePath, StoredDatabase } from "./persistence/database";
import { Database } from "./persistence/database";
import type { SyncSettings } from "./persistence/settings";
import { Settings } from "./persistence/settings";
import { SyncService } from "./services/sync-service";
import { Syncer } from "./sync-operations/syncer";
import type { FileSystemOperations } from "./file-operations/filesystem-operations";
import { FileOperations } from "./file-operations/file-operations";
import { ConnectionStatus } from "./services/connection-status";
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

export class SyncClient {
	private static readonly MINIMUM_SAVE_INTERVAL_MS = 1000;
	private hasFinishedOfflineSync = false;

	// eslint-disable-next-line @typescript-eslint/max-params
	private constructor(
		private readonly history: SyncHistory,
		private readonly settings: Settings,
		private readonly database: Database,
		private readonly syncer: Syncer,
		private readonly syncService: SyncService,
		private readonly webSocketManager: WebSocketManager,
		private readonly _logger: Logger,
		private readonly connectionStatus: ConnectionStatus,
		private readonly cursorTracker: CursorTracker,
		private readonly fileChangeNotifier: FileChangeNotifier
	) {
		this.settings.addOnSettingsChangeListener(
			async (newSettings, oldSettings) => {
				if (newSettings.vaultName !== oldSettings.vaultName) {
					await this.reset();
				}

				if (newSettings.isSyncEnabled !== oldSettings.isSyncEnabled) {
					if (newSettings.isSyncEnabled) {
						await this.start();
					} else {
						this.stop();
					}
				}
			}
		);
	}

	public get logger(): Logger {
		return this._logger;
	}

	public get documentCount(): number {
		return this.database.length;
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

		logger.info(`Initialising SyncClient with client id ${deviceId}`);

		const history = new SyncHistory(logger);

		let state = (await persistence.load()) ?? {
			settings: undefined,
			database: undefined
		};

		const rateLimitedSave = rateLimit(
			persistence.save,
			SyncClient.MINIMUM_SAVE_INTERVAL_MS
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

		const connectionStatus = new ConnectionStatus(settings, logger);
		const syncService = new SyncService(
			deviceId,
			connectionStatus,
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

		const unrestrictedSyncer = new UnrestrictedSyncer(
			logger,
			database,
			settings,
			syncService,
			fileOperations,
			history
		);

		const syncer = new Syncer(
			logger,
			database,
			settings,
			syncService,
			fileOperations,
			unrestrictedSyncer
		);

		const webSocketManager = new WebSocketManager(
			deviceId,
			logger,
			database,
			settings,
			syncer,
			webSocket
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
			connectionStatus,
			cursorTracker,
			fileChangeNotifier
		);

		logger.info("SyncClient initialised");

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

	public async start(): Promise<void> {
		await this.syncer.scheduleSyncForOfflineChanges();
		this.hasFinishedOfflineSync = true;
		this.webSocketManager.start();
	}

	public stop(): void {
		this.hasFinishedOfflineSync = false;
		this.webSocketManager.stop();
	}

	public async waitAndStop(): Promise<void> {
		this.stop();
		await this.syncer.waitUntilFinished();
	}

	/// Wait for the in-flight operations to finish, reset all tracking,
	/// and the local database but retain the settings.
	/// The SyncClient can be used again after calling this method.
	public async reset(): Promise<void> {
		this.stop();
		this.connectionStatus.startReset();
		await this.syncer.reset();
		this.history.reset();
		this.database.reset();
		this._logger.reset();
		this.connectionStatus.finishReset();
		await this.start();
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
		handler: (settings: SyncSettings, oldSettings: SyncSettings) => unknown
	): void {
		this.settings.addOnSettingsChangeListener(handler);
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

		if (
			!this.webSocketManager.isFirstSyncCompleted ||
			!this.hasFinishedOfflineSync
		) {
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
