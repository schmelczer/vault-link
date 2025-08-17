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
import { DocumentUpdateStatus } from "./types/document-update-status";
import { WebSocketManager } from "./services/websocket-manager";
import { createClientId } from "./utils/create-client-id";
import type { CursorSpan } from "./services/types/CursorSpan";
import type { ClientCursors } from "./services/types/ClientCursors";
import type { DocumentWithCursors } from "./services/types/DocumentWithCursors";
import { hash } from "./utils/hash";
import type { DocumentWithMaybeOutdatedClientCursors } from "./types/maybe-outdated-client-cursors";

enum DocumentUpToDateness {
	UpToDate = "UpToDate",
	Prior = "Prior",
	Later = "Later"
}

export class SyncClient {
	private static readonly MINIMUM_SAVE_INTERVAL_MS = 1000;
	private lastCursorState: DocumentWithCursors[] = [];

	private readonly knownClientCursors: ClientCursors[] = [];

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
		private readonly fileOperations: FileOperations
	) {
		this.settings.addOnSettingsChangeListener(
			(newSettings, oldSettings) => {
				if (newSettings.vaultName !== oldSettings.vaultName) {
					void this.reset();
				}
			}
		);

		this.webSocketManager.addRemoteCursorsUpdateListener((cursors) => {
			this.knownClientCursors.push(...cursors);
		});
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
			deviceId,
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

		const client = new SyncClient(
			history,
			settings,
			database,
			syncer,
			syncService,
			webSocketManager,
			logger,
			connectionStatus,
			fileOperations
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
		listener: (stats: HistoryStats) => void
	): void {
		this.history.addSyncHistoryUpdateListener(listener);
	}

	public async start(): Promise<void> {
		await this.syncer.scheduleSyncForOfflineChanges();
	}

	public stop(): void {
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
		await this.webSocketManager.reset();
		this.history.reset();
		this.database.reset();
		this._logger.reset();
		this.connectionStatus.finishReset();
		void this.start();
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
		handler: (settings: SyncSettings, oldSettings: SyncSettings) => void
	): void {
		this.settings.addOnSettingsChangeListener(handler);
	}

	public addRemainingSyncOperationsListener(
		listener: (remainingOperations: number) => void
	): void {
		this.syncer.addRemainingOperationsListener(listener);
	}

	public addWebSocketStatusChangeListener(listener: () => void): void {
		this.webSocketManager.addWebSocketStatusChangeListener(listener);
	}

	public async syncLocallyCreatedFile(
		relativePath: RelativePath
	): Promise<void> {
		return this.syncer.syncLocallyCreatedFile(relativePath);
	}

	public async syncLocallyDeletedFile(
		relativePath: RelativePath
	): Promise<void> {
		return this.syncer.syncLocallyDeletedFile(relativePath);
	}

	public async syncLocallyUpdatedFile({
		oldPath,
		relativePath
	}: {
		oldPath?: RelativePath;
		relativePath: RelativePath;
	}): Promise<void> {
		return this.syncer.syncLocallyUpdatedFile({
			oldPath,
			relativePath
		});
	}

	public getDocumentSyncingStatus(
		relativePath: RelativePath
	): DocumentUpdateStatus {
		const document =
			this.database.getLatestDocumentByRelativePath(relativePath);
		if (document === undefined) {
			return DocumentUpdateStatus.SYNCING;
		}
		return document.updates.length > 0
			? DocumentUpdateStatus.SYNCING
			: DocumentUpdateStatus.UP_TO_DATE;
	}

	/// Update the local cursors for the given documents.
	/// Can be called frequently as it only emits an event
	// if the state has actually changed.
	public async updateLocalCursors(
		documentToCursors: Record<RelativePath, CursorSpan[]>
	): Promise<void> {
		const documentsWithCursors: DocumentWithCursors[] = [];

		for (const [relativePath, cursors] of Object.entries(
			documentToCursors
		)) {
			const record =
				this.database.getLatestDocumentByRelativePath(relativePath);

			if (!record) {
				continue; // Let's wait for the file to be created before sending cursors
			}

			const readContent = await this.fileOperations.read(relativePath);

			if (record.metadata?.hash !== hash(readContent)) {
				continue; // Wouldn't make sense to sync the positions in a dirty file
			}

			documentsWithCursors.push({
				relative_path: relativePath,
				document_id: record.documentId,
				vault_update_id: record.metadata.parentVersionId,
				cursors
			});
		}

		if (
			JSON.stringify(this.lastCursorState) ===
			JSON.stringify(documentsWithCursors)
		) {
			return;
		}

		this.lastCursorState = documentsWithCursors;

		this.webSocketManager.updateLocalCursors({ documentsWithCursors });
	}

	public addRemoteCursorsUpdateListener(
		listener: (cursors: DocumentWithMaybeOutdatedClientCursors[]) => void
	): void {
		this.webSocketManager.addRemoteCursorsUpdateListener(async () => {
			listener(await this.getRelevantClientCursors());
		});
	}

	private async getRelevantClientCursors(): Promise<
		DocumentWithMaybeOutdatedClientCursors[]
	> {
		const result: DocumentWithMaybeOutdatedClientCursors[] = [];
		const included = new Set<string>();
		for (const clientCursors of [...this.knownClientCursors].reverse()) {
			if (included.has(clientCursors.deviceId)) {
				continue;
			}

			const upToDateness =
				await this.getDocumentsUpToDateness(clientCursors);
			if (upToDateness == DocumentUpToDateness.Later) {
				continue;
			}

			result.push({
				...clientCursors,
				isOutdated: upToDateness == DocumentUpToDateness.Prior
			});

			included.add(clientCursors.deviceId);
		}

		return result;
	}

	private async getDocumentsUpToDateness(
		clientCursor: ClientCursors
	): Promise<DocumentUpToDateness> {
		const results = [];
		for (const document of clientCursor.documentsWithCursors) {
			results.push(await this.getDocumentUpToDateness(document));
		}

		if (
			results.every((result) => result === DocumentUpToDateness.UpToDate)
		) {
			return DocumentUpToDateness.UpToDate;
		}

		if (
			results.every(
				(result) =>
					result === DocumentUpToDateness.UpToDate ||
					result === DocumentUpToDateness.Prior
			)
		) {
			return DocumentUpToDateness.Prior;
		}

		return DocumentUpToDateness.Later;
	}

	private async getDocumentUpToDateness(
		document: DocumentWithCursors
	): Promise<DocumentUpToDateness> {
		const record = this.database.getLatestDocumentByRelativePath(
			document.relative_path
		);

		if (!record) {
			// the document of the cursor must be from the future
			return DocumentUpToDateness.Later;
		}

		if (
			(record.metadata?.parentVersionId ?? 0) < document.vault_update_id
		) {
			return DocumentUpToDateness.Later;
		} else if (
			document.vault_update_id < (record.metadata?.parentVersionId ?? 0)
		) {
			// the document of the cursor must be from the past
			return DocumentUpToDateness.Prior;
		}

		const currentContent = await this.fileOperations.read(
			document.relative_path
		);

		return this.database.getLatestDocumentByRelativePath(
			document.relative_path
		)?.metadata?.hash === hash(currentContent)
			? DocumentUpToDateness.UpToDate
			: DocumentUpToDateness.Prior;
	}
}
