import { SUPPORTED_API_VERSION } from "../consts";
import { AuthenticationError } from "../errors/authentication-error";
import { ServerVersionMismatchError } from "../errors/server-version-mismatch-error";
import type { SyncService } from "./sync-service";
import type { PingResponse } from "./types/PingResponse";

export interface ServerConfigData {
    mergeableFileExtensions: string[];
    supportedApiVersion: number;
    isAuthenticated: boolean;
}

export class ServerConfig {
    private response: Promise<PingResponse> | undefined;
    private config: ServerConfigData | undefined;

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

    public async checkConnection(forceUpdate = false): Promise<{
        isSuccessful: boolean;
        message: string;
    }> {
        try {
            let { response } = this;
            if (!response || forceUpdate) {
                response = this.response = this.syncService.ping();
            }

            const result: PingResponse = await response; // it must be defined, otherwise we would have thrown above
            this.config = result;

            if (result.isAuthenticated) {
                return {
                    isSuccessful: true,
                    message: `Successfully connected to server (version: ${result.serverVersion}) and authenticated`
                };
            }

            return {
                isSuccessful: false,
                message: `Successfully connected to server (version: ${result.serverVersion}) but failed to authenticate`
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
            this.response ??= this.syncService.ping();
            this.config = await this.response;
        }

        ServerConfig.validateConfig(this.config);

        return this.config;
    }

    public reset(): void {
        this.response = undefined;
        this.config = undefined;
    }
}
