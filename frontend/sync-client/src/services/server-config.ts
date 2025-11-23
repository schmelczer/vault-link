import { SUPPORTED_API_VERSION } from "../consts";
import { AuthenticationError } from "./authentication-error";
import { ServerVersionMismatchError } from "./server-version-mismatch-error";
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

	public async initialize(): Promise<void> {
		this.response = this.syncService.ping();
		this.config = await this.response;

		if (this.config.supportedApiVersion !== SUPPORTED_API_VERSION) {
			const shouldUpgradeClient =
				this.config.supportedApiVersion > SUPPORTED_API_VERSION;
			throw new ServerVersionMismatchError(
				`Unsupported API version: ${this.config.supportedApiVersion}. Consider upgrading the ${
					shouldUpgradeClient ? "client" : "sync-server"
				} to ensure compatibility.`
			);
		}

		if (!this.config.isAuthenticated) {
			throw new AuthenticationError(
				"Failed to authenticate with the sync-server."
			);
		}
	}

	public async checkConnection(forceUpdate = false): Promise<{
		isSuccessful: boolean;
		message: string;
	}> {
		try {
			let { response } = this;
			if (!response && !forceUpdate) {
				throw new Error("ServerConfig not initialized");
			} else if (forceUpdate) {
				response = this.response = this.syncService.ping();
			}

			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const result: PingResponse = (await response)!; // it must be defined, otherwise we would have thrown above
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

	public getConfig(): ServerConfigData {
		if (!this.config) {
			throw new Error("ServerConfig not initialized");
		}

		return this.config;
	}

	public reset(): void {
		this.response = undefined;
		this.config = undefined;
	}
}
