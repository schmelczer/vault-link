import { createPromise } from "../utils/create-promise";
import type { SyncService } from "./sync-service";
import type { PingResponse } from "./types/PingResponse";

export interface ServerConfigData {
	mergeableFileExtensions: string[];
}

export class ServerConfig {
	private response: Promise<PingResponse> | undefined;
	private config: ServerConfigData | undefined;

	public constructor(private readonly syncService: SyncService) {}

	public async initialize(): Promise<void> {
		this.response = this.syncService.ping();
		this.config = await this.response;
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
