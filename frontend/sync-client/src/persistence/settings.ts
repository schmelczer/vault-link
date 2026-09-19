import type { Logger } from "../tracing/logger";
import { Lock } from "../utils/data-structures/locks";
import { EventListeners } from "../utils/data-structures/event-listeners";

export interface SyncSettings {
    remoteUri: string;
    token: string;
    vaultName: string;
    isSyncEnabled: boolean;
    maxFileSizeMB: number;
    ignorePatterns: string[];
    webSocketRetryIntervalMs: number;
    enableTelemetry: boolean;
    requestTimeoutMs: number;
    networkRetryIntervalMs: number;
    syncIntervalMs?: number;
}

export const DEFAULT_SETTINGS: SyncSettings = {
    remoteUri: "",
    token: "",
    vaultName: "default",
    isSyncEnabled: false,
    maxFileSizeMB: 10,
    ignorePatterns: [],
    webSocketRetryIntervalMs: 3500,
    enableTelemetry: false,
    requestTimeoutMs: 30_000,
    networkRetryIntervalMs: 1000,
    syncIntervalMs: undefined
};

const redactSettings = (value: Partial<SyncSettings>): object => ({
    ...value,
    ...(value.token === undefined ? {} : { token: "[REDACTED]" })
});

export class Settings {
    public readonly onSettingsChanged = new EventListeners<
        (newSettings: SyncSettings, oldSettings: SyncSettings) => unknown
    >();

    private settings: SyncSettings;
    private readonly lock: Lock = new Lock();

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
            `Loaded settings: ${JSON.stringify(redactSettings(this.settings), null, 2)}`
        );
    }

    public getSettings(): SyncSettings {
        return {
            ...this.settings,
            ignorePatterns: [...this.settings.ignorePatterns]
        };
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
                `Updating settings with: ${JSON.stringify(redactSettings(value))}`
            );
            const oldSettings = this.settings;
            const next = { ...this.settings, ...value };
            await this.saveData(next);
            this.settings = next;

            await this.onSettingsChanged.triggerAsync(
                this.getSettings(),
                oldSettings
            );
        });
    }
}
