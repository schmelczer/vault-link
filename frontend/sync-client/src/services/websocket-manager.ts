import type { Logger } from "../tracing/logger";
import type { Settings } from "../persistence/settings";
import type { WebSocketServerMessage } from "./types/WebSocketServerMessage";
import type { WebSocketClientMessage } from "./types/WebSocketClientMessage";
import type { CursorPositionFromClient } from "./types/CursorPositionFromClient";
import type { ClientCursors } from "./types/ClientCursors";
import { createPromise } from "../utils/create-promise";
import type { WebSocketVaultUpdate } from "./types/WebSocketVaultUpdate";
import { awaitAll } from "../utils/await-all";

export class WebSocketManager {
	private readonly webSocketStatusChangeListeners: ((
		isConnected: boolean
	) => unknown)[] = [];

	private readonly remoteVaultUpdateListeners: ((
		update: WebSocketVaultUpdate
	) => Promise<void>)[] = [];

	private readonly remoteCursorsUpdateListeners: ((
		cursors: ClientCursors[]
	) => Promise<void>)[] = [];

	private isStopped = true;
	private resolveDisconnectingPromise: null | (() => unknown) = null;
	private reconnectTimeoutId: ReturnType<typeof setTimeout> | undefined;

	private readonly outstandingPromises: Promise<unknown>[] = [];

	private webSocket: WebSocket | undefined;
	private readonly webSocketFactoryImplementation: typeof globalThis.WebSocket;

	public constructor(
		private readonly deviceId: string,
		private readonly logger: Logger,
		private readonly settings: Settings,
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
	}

	public get isWebSocketConnected(): boolean {
		return (
			this.webSocket?.readyState ===
			this.webSocketFactoryImplementation.OPEN
		);
	}

	public addWebSocketStatusChangeListener(
		listener: (isConnected: boolean) => unknown
	): void {
		this.webSocketStatusChangeListeners.push(listener);
	}

	public addRemoteCursorsUpdateListener(
		listener: (cursors: ClientCursors[]) => Promise<void>
	): void {
		this.remoteCursorsUpdateListeners.push(listener);
	}

	public addRemoteVaultUpdateListener(
		listener: (update: WebSocketVaultUpdate) => Promise<void>
	): void {
		this.remoteVaultUpdateListeners.push(listener);
	}

	public start(): void {
		this.isStopped = false;
		this.initializeWebSocket();
	}

	public async stop(): Promise<void> {
		const [promise, resolve] = createPromise();
		this.resolveDisconnectingPromise = resolve;

		this.isStopped = true;

		// Clear pending reconnect timeout
		if (this.reconnectTimeoutId !== undefined) {
			clearTimeout(this.reconnectTimeoutId);
			this.reconnectTimeoutId = undefined;
		}

		this.webSocket?.close(1000, "WebSocketManager has been stopped");

		while (this.isWebSocketConnected) {
			await promise;
		}

		await awaitAll(this.outstandingPromises);
	}

	public sendHandshakeMessage(
		message: WebSocketClientMessage & { type: "handshake" }
	): void {
		const { webSocket } = this;
		if (!webSocket) {
			throw new Error(
				"WebSocket is not connected, cannot send handshake message"
			);
		}

		webSocket.send(JSON.stringify(message));
	}

	public updateLocalCursors(cursorPositions: CursorPositionFromClient): void {
		if (!this.isWebSocketConnected) {
			// A missing cursor update is fine, we can just skip it if needed
			this.logger.warn(
				"WebSocket is not connected, cannot send cursor positions"
			);
			return;
		}
		const message: WebSocketClientMessage = {
			type: "cursorPositions",
			...cursorPositions
		};
		const { webSocket } = this;
		if (!webSocket) {
			this.logger.warn(
				"WebSocket is not connected, cannot send cursor positions"
			);
			return;
		}
		webSocket.send(JSON.stringify(message));
		this.logger.debug(
			`Sent cursor positions: ${JSON.stringify(cursorPositions)}`
		);
	}

	private initializeWebSocket(): void {
		try {
			this.webSocket?.close();
		} catch (e) {
			this.logger.error(
				`Failed to close previous WebSocket connection: ${e}`
			);
		}

		const wsUri = new URL(this.settings.getSettings().remoteUri);
		wsUri.protocol = wsUri.protocol === "https" ? "wss" : "ws";
		wsUri.pathname = `/vaults/${this.settings.getSettings().vaultName}/ws`;

		this.logger.info(`Connecting to WebSocket at ${wsUri.toString()}`);

		this.webSocket = new this.webSocketFactoryImplementation(wsUri);

		this.webSocket.onopen = (): void => {
			this.logger.info("WebSocket connection opened");
			this.webSocketStatusChangeListeners.forEach((listener) =>
				listener(true)
			);
		};

		this.webSocket.onmessage = (event): void => {
			try {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				const message = JSON.parse(
					event.data
				) as WebSocketServerMessage;

				void this.handleWebSocketMessage(message).catch(
					(error: unknown) => {
						this.logger.error(
							`Error handling WebSocket message: ${String(error)}`
						);
					}
				);
			} catch (error) {
				this.logger.error(
					`Error parsing WebSocket message: ${String(error)}`
				);
			}
		};

		this.webSocket.onclose = (event): void => {
			this.logger.error(
				`WebSocket closed with code ${event.code} (${event.reason == "" ? "unknown reason" : event.reason})`
			);
			this.webSocketStatusChangeListeners.forEach((listener) =>
				listener(false)
			);

			if (this.isStopped) {
				this.resolveDisconnectingPromise?.();
				this.resolveDisconnectingPromise = null;
			} else {
				this.reconnectTimeoutId = setTimeout(() => {
					this.reconnectTimeoutId = undefined;
					this.initializeWebSocket();
				}, this.settings.getSettings().webSocketRetryIntervalMs);
			}
		};
	}

	private async handleWebSocketMessage(
		message: WebSocketServerMessage
	): Promise<void> {
		if (message.type === "vaultUpdate") {
			const promises = this.remoteVaultUpdateListeners.map(
				async (listener) => {
					const trackedPromise = listener(message)
						.catch((error: unknown) => {
							this.logger.error(
								`Error in vault update listener: ${String(error)}`
							);
						})
						.finally(() => {
							const index =
								this.outstandingPromises.indexOf(
									trackedPromise
								);
							if (index !== -1) {
								// eslint-disable-next-line @typescript-eslint/no-floating-promises
								this.outstandingPromises.splice(index, 1);
							}
						});
					await trackedPromise;
				}
			);
			this.outstandingPromises.push(...promises);
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		} else if (message.type === "cursorPositions") {
			this.logger.debug(
				`Received cursor positions for ${JSON.stringify(message.clients)}`
			);
			const filteredClients = message.clients.filter(
				(client) => client.deviceId !== this.deviceId
			);
			const promises = this.remoteCursorsUpdateListeners.map(
				async (listener) => {
					const trackedPromise = listener(filteredClients)
						.catch((error: unknown) => {
							this.logger.error(
								`Error in cursor positions listener: ${String(error)}`
							);
						})
						.finally(() => {
							const index =
								this.outstandingPromises.indexOf(
									trackedPromise
								);
							if (index !== -1) {
								// eslint-disable-next-line @typescript-eslint/no-floating-promises
								this.outstandingPromises.splice(index, 1);
							}
						});
					await trackedPromise;
				}
			);
			this.outstandingPromises.push(...promises);
		} else {
			this.logger.warn(
				`Received unknown message type: ${JSON.stringify(message)}`
			);
		}
	}
}
