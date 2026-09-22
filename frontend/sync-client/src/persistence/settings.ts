import type { Logger } from "../tracing/logger";
import { globsToRegexes } from "../utils/globs-to-regexes";
import { isInternalPath } from "../utils/portable-path";
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
    diffCacheSizeMB: number;
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
    diffCacheSizeMB: 4,
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
    private ignorePatterns: RegExp[];
    private readonly lock: Lock = new Lock();

    public constructor(
        private readonly logger: Logger,
        initialState: Partial<SyncSettings> | undefined,
        private readonly saveData: (data: SyncSettings) => Promise<void>
    ) {
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...structuredClone(initialState ?? {})
        };

        this.ignorePatterns = globsToRegexes(
            this.settings.ignorePatterns,
            logger
        );

        this.logger.debug(
            `Loaded settings: ${JSON.stringify(redactSettings(this.settings), null, 2)}`
        );
    }

    public isIgnored(path: string): boolean {
        return (
            isInternalPath(path) ||
            this.ignorePatterns.some((pattern) => pattern.test(path))
        );
    }

    public isOversized(size: number): boolean {
        return size > this.settings.maxFileSizeMB * 1024 * 1024;
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

    public async setSettings(
        value: Partial<SyncSettings>,
        notify = true
    ): Promise<void> {
        const update = structuredClone(value);

        const change = await this.lock.withLock(async () => {
            this.logger.debug(
                `Updating settings with: ${JSON.stringify(redactSettings(update))}`
            );

            const oldSettings = this.getSettings();
            const next = { ...this.settings, ...update };
            await this.saveData(next);
            this.settings = next;
            if (update.ignorePatterns !== undefined)
                this.ignorePatterns = globsToRegexes(
                    next.ignorePatterns,
                    this.logger
                );

            return [this.getSettings(), oldSettings] as const;
        });

        // Listeners can themselves update settings. Never await them while
        // holding a lock needed by the operation they invoke.
        if (notify) await this.onSettingsChanged.triggerAsync(...change);
    }
}
