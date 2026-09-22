import { SUPPORTED_API_VERSION } from "../consts";
import {
    AuthenticationError,
    ServerVersionMismatchError
} from "../errors/errors";
import type { SyncService } from "./sync-service";

export interface ServerConfigData {
    mergeableFileExtensions: string[];
    supportedApiVersion: number;
    isAuthenticated: boolean;
}

export class ServerConfig {
    private config: Promise<ServerConfigData> | undefined;

    public constructor(private readonly syncService: SyncService) {}

    private static validateConfig(config: ServerConfigData): void {
        if (config.supportedApiVersion !== SUPPORTED_API_VERSION) {
            const shouldUpgradeClient =
                config.supportedApiVersion > SUPPORTED_API_VERSION;
            throw new ServerVersionMismatchError(
                `Unsupported API version: ${config.supportedApiVersion}. Consider upgrading the ${
                    shouldUpgradeClient ? "client" : "sync-server"
                } to ensure compatibility`
            );
        }

        if (!config.isAuthenticated) {
            throw new AuthenticationError(
                "Failed to authenticate with the sync-server"
            );
        }
    }

    // warm the cache
    public async initialize(): Promise<void> {
        await this.getConfig();
    }

    public async checkConnection(): Promise<{
        isSuccessful: boolean;
        message: string;
    }> {
        try {
            const result = await this.syncService.ping();
            ServerConfig.validateConfig(result);
            return {
                isSuccessful: true,
                message: `Successfully connected to server (version: ${result.serverVersion}) and authenticated`
            };
        } catch (e) {
            return {
                isSuccessful: false,
                message: `Failed to connect to server: ${e}`
            };
        }
    }

    public async getConfig(): Promise<ServerConfigData> {
        if (!this.config) {
            const pending = this.syncService
                .ping()
                .then((config) => {
                    ServerConfig.validateConfig(config);
                    return config;
                })
                .catch((error: unknown) => {
                    if (this.config === pending) this.config = undefined;
                    throw error;
                });
            this.config = pending;
        }
        return this.config;
    }

    public reset(): void {
        this.config = undefined;
    }
}
