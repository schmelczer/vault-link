import type { Database } from "../persistence/database";
import type { Logger } from "../tracing/logger";
import type { Settings, SyncSettings } from "../persistence/settings";
import type { WebSocketServerMessage } from "./types/WebSocketServerMessage";
import type { Syncer } from "../sync-operations/syncer";
import type { WebSocketClientMessage } from "./types/WebSocketClientMessage";
import type { CursorPositionFromClient } from "./types/CursorPositionFromClient";
import type { ClientCursors } from "./types/ClientCursors";

export class WebSocketManager {
	private readonly webSocketStatusChangeListeners: (() => unknown)[] = [];
	private readonly remoteCursorsUpdateListeners: ((
		cursors: ClientCursors[]
	) => unknown)[] = [];

	private webSocket: WebSocket | undefined;

	private isStopped = true;
	private _isFirstSyncCompleted = false;

	private readonly webSocketFactoryImplementation: typeof globalThis.WebSocket;

	public constructor(
		private readonly deviceId: string,
		private readonly logger: Logger,
		private readonly database: Database,
		private readonly settings: Settings,
		private readonly syncer: Syncer,
		webSocketImplementation?: typeof globalThis.WebSocket
	) {
		if (webSocketImplementation) {
			this.webSocketFactoryImplementation = webSocketImplementation;
		} else {
			if (
				typeof globalThis !== "undefined" &&
				typeof globalThis.WebSocket === "undefined"
			) {
				// eslint-disable-next-line
				this.webSocketFactoryImplementation = require("ws"); // polyfill for WebSocket in Node.js
			} else {
				this.webSocketFactoryImplementation = WebSocket;
			}
		}

		settings.addOnSettingsChangeListener((newSettings, oldSettings) => {
			if (
				newSettings.remoteUri !== oldSettings.remoteUri ||
				newSettings.vaultName !== oldSettings.vaultName ||
				newSettings.token !== oldSettings.token
			) {
				this.initializeWebSocket(newSettings);
			}
		});
	}

	public get isWebSocketConnected(): boolean {
		return (
			this.webSocket?.readyState ===
			this.webSocketFactoryImplementation.OPEN
		);
	}

	public get isFirstSyncCompleted(): boolean {
		return this._isFirstSyncCompleted;
	}

	public addWebSocketStatusChangeListener(listener: () => unknown): void {
		this.webSocketStatusChangeListeners.push(listener);
	}

	public addRemoteCursorsUpdateListener(
		listener: (cursors: ClientCursors[]) => unknown
	): void {
		this.remoteCursorsUpdateListeners.push(listener);
	}

	public removeRemoteCursorsUpdateListener(
		listener: (cursors: ClientCursors[]) => unknown
	): void {
		const index = this.remoteCursorsUpdateListeners.indexOf(listener);
		if (index !== -1) {
			this.remoteCursorsUpdateListeners.splice(index, 1);
		}
	}

	public start(): void {
		this.isStopped = false;
		this._isFirstSyncCompleted = false;
		this.initializeWebSocket(this.settings.getSettings());
	}

	public stop(): void {
		this.isStopped = true;
		this.webSocket?.close(1000, "WebSocketManager has been stopped");
	}

	public updateLocalCursors(cursorPositions: CursorPositionFromClient): void {
		if (!this.isWebSocketConnected) {
			this.logger.warn(
				"WebSocket is not connected, cannot send cursor positions"
			);
			return;
		}
		const message: WebSocketClientMessage = {
			type: "cursorPositions",
			...cursorPositions
		};
		this.webSocket?.send(JSON.stringify(message));
		this.logger.debug(
			`Sent cursor positions: ${JSON.stringify(cursorPositions)}`
		);
	}

	private initializeWebSocket(settings: SyncSettings): void {
		if (this.isStopped) {
			return;
		}

		try {
			this.webSocket?.close();
		} catch (e) {
			this.logger.warn(`Failed to close WebSocket: ${e}`);
		}

		const wsUri = new URL(settings.remoteUri);
		wsUri.protocol = wsUri.protocol === "https" ? "wss" : "ws";
		wsUri.pathname = `/vaults/${settings.vaultName}/ws`;

		this.logger.info(`Connecting to WebSocket at ${wsUri.toString()}`);

		this.webSocket = new this.webSocketFactoryImplementation(wsUri);

		// The JS WebSocket API doesn't support setting headers, so we have to send the token as a message
		this.webSocket.onopen = (): void => {
			this.logger.info("WebSocket connection opened");
			this.webSocketStatusChangeListeners.forEach((l) => l());

			const message: WebSocketClientMessage = {
				type: "handshake",
				deviceId: this.deviceId,
				token: settings.token,
				lastSeenVaultUpdateId: this.database.getLastSeenUpdateId()
			};
			this.webSocket?.send(JSON.stringify(message));
		};

		this.webSocket.onmessage = async (event): Promise<void> => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const message = JSON.parse(event.data) as WebSocketServerMessage;
			return this.handleWebSocketMessage(message);
		};

		this.webSocket.onclose = (event): void => {
			this.logger.warn(
				`WebSocket closed with code ${event.code} (${event.reason == "" ? "unknown reason" : event.reason})`
			);
			this.webSocketStatusChangeListeners.forEach((l) => l());

			if (!this.isStopped) {
				setTimeout(() => {
					this.initializeWebSocket(this.settings.getSettings());
				}, this.settings.getSettings().webSocketRetryIntervalMs);
			}
		};
	}

	private async handleWebSocketMessage(
		message: WebSocketServerMessage
	): Promise<void> {
		if (message.type === "vaultUpdate") {
			try {
				await Promise.all(
					message.documents.map(async (document) =>
						this.syncer.syncRemotelyUpdatedFile(document)
					)
				);

				if (message.isInitialSync && message.documents.length > 0) {
					this.database.setLastSeenUpdateId(
						message.documents
							.map((document) => document.vaultUpdateId)
							.reduce((a, b) => Math.max(a, b))
					);
				}

				this._isFirstSyncCompleted = true;
			} catch (e) {
				this.logger.error(`Failed to sync remotely updated file: ${e}`);
			}
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		} else if (message.type === "cursorPositions") {
			this.logger.debug(
				`Received cursor positions for ${JSON.stringify(message.clients)}`
			);
			this.remoteCursorsUpdateListeners.forEach((listener) => {
				listener(
					message.clients.filter(
						(client) => client.deviceId !== this.deviceId
					)
				);
			});
		} else {
			this.logger.warn(
				`Received unknown message type: ${JSON.stringify(message)}`
			);
		}
	}
}
