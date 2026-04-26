import type { Logger } from "../tracing/logger";
import { Lock } from "../utils/data-structures/locks";
import { EventListeners } from "../utils/data-structures/event-listeners";

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
};

export class Settings {
    public readonly onSettingsChanged = new EventListeners<
        (newSettings: SyncSettings, oldSettings: SyncSettings) => unknown
    >();

    private settings: SyncSettings;
    private readonly lock: Lock;

    public constructor(
        private readonly logger: Logger,
        initialState: Partial<SyncSettings> | undefined,
        private readonly saveData: (data: SyncSettings) => Promise<void>
    ) {
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...(initialState ?? {})
        };

        this.lock = new Lock(Settings.name, this.logger);

        this.logger.debug(
            `Loaded settings: ${JSON.stringify(this.settings, null, 2)}`
        );
    }

    public getSettings(): SyncSettings {
        return this.settings;
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

            await this.onSettingsChanged.triggerAsync(
                this.settings,
                oldSettings
            );

            await this.save();
        });
    }

    private async save(): Promise<void> {
        await this.saveData(this.settings);
    }
}
