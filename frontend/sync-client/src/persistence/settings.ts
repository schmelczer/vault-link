import type { Logger } from "../tracing/logger";
import { awaitAll } from "../utils/await-all";
import { Lock } from "../utils/data-structures/locks";
import { removeFromArray } from "../utils/remove-from-array";

export interface SyncSettings {
	remoteUri: string;
	token: string;
	vaultName: string;
	syncConcurrency: number;
	isSyncEnabled: boolean;
	maxFileSizeMB: number;
	ignorePatterns: string[];
	webSocketRetryIntervalMs: number;
	diffCacheSizeMB: number;
	enableTelemetry: boolean;
	networkRetryIntervalMs: number;
	minimumSaveIntervalMs: number;
}

export const DEFAULT_SETTINGS: SyncSettings = {
	remoteUri: "",
	token: "",
	vaultName: "default",
	syncConcurrency: 1,
	isSyncEnabled: false,
	maxFileSizeMB: 10,
	ignorePatterns: [],
	webSocketRetryIntervalMs: 3500,
	diffCacheSizeMB: 4,
	enableTelemetry: false,
	networkRetryIntervalMs: 1000,
	minimumSaveIntervalMs: 1000
};

export class Settings {
	private settings: SyncSettings;
	private readonly lock: Lock = new Lock();

	private readonly onSettingsChangeHandlers: ((
		newSettings: SyncSettings,
		oldSettings: SyncSettings
	) => unknown)[] = [];

	public constructor(
		private readonly logger: Logger,
		initialState: Partial<SyncSettings> | undefined,
		private readonly saveData: (data: SyncSettings) => Promise<void>
	) {
		this.settings = {
			...DEFAULT_SETTINGS,
			...(initialState ?? {})
		};

		this.logger.debug(
			`Loaded settings: ${JSON.stringify(this.settings, null, 2)}`
		);
	}

	public getSettings(): SyncSettings {
		return this.settings;
	}

	public addOnSettingsChangeListener(
		listener: (settings: SyncSettings, oldSettings: SyncSettings) => unknown
	): void {
		this.onSettingsChangeHandlers.push(listener);
	}

	public removeOnSettingsChangeListener(
		listener: (settings: SyncSettings, oldSettings: SyncSettings) => unknown
	): void {
		removeFromArray(this.onSettingsChangeHandlers, listener);
	}

	public async setSetting<T extends keyof SyncSettings>(
		key: T,
		value: SyncSettings[T]
	): Promise<void> {
		await this.setSettings({
			[key]: value
		});
	}

	public async setSettings(value: Partial<SyncSettings>): Promise<void> {
		await this.lock.withLock(async () => {
			this.logger.debug(
				`Updating settings with: ${JSON.stringify(value)}`
			);
			const oldSettings = this.settings;
			this.settings = {
				...this.settings,
				...value
			};

			await awaitAll(
				this.onSettingsChangeHandlers
					.map((handler) => {
						return handler(this.settings, oldSettings);
					})
					.filter((result): result is Promise<unknown> => {
						return result instanceof Promise;
					})
			);

			await this.save();
		});
	}

	private async save(): Promise<void> {
		await this.saveData(this.settings);
	}
}
