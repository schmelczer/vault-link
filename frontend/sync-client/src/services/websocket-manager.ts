import type { Logger } from "../tracing/logger";
import type { Settings } from "../persistence/settings";
import type { WebSocketServerMessage } from "./types/WebSocketServerMessage";
import type { WebSocketClientMessage } from "./types/WebSocketClientMessage";
import type { CursorPositionFromClient } from "./types/CursorPositionFromClient";
import type { ClientCursors } from "./types/ClientCursors";
import { createPromise } from "../utils/create-promise";
import type { WebSocketVaultUpdate } from "./types/WebSocketVaultUpdate";
import { WEBSOCKET_DISCONNECT_TIMEOUT_IN_SECONDS } from "../consts";
import { removeFromArray } from "../utils/remove-from-array";
import { EventListeners } from "../utils/data-structures/event-listeners";
import { awaitAll } from "../utils/await-all";

export class WebSocketManager {
    public readonly onWebSocketStatusChanged = new EventListeners<
        (isConnected: boolean) => unknown
    >();

    public readonly onRemoteVaultUpdateReceived = new EventListeners<
        (update: WebSocketVaultUpdate) => Promise<void>
    >();

    public readonly onRemoteCursorsUpdateReceived = new EventListeners<
        (cursors: ClientCursors[]) => Promise<void>
    >();

    private isStopped = true;
    private resolveDisconnectingPromise: null | (() => unknown) = null;
    private reconnectTimeoutId: ReturnType<typeof setTimeout> | undefined;

    private readonly outstandingPromises: Promise<unknown>[] = [];

    private webSocket: WebSocket | undefined;

    public constructor(
        private readonly logger: Logger,
        private readonly settings: Settings,
        private readonly webSocketFactoryImplementation: typeof globalThis.WebSocket = WebSocket
    ) {}

    public get isWebSocketConnected(): boolean {
        return (
            this.webSocket?.readyState ===
            this.webSocketFactoryImplementation.OPEN
        );
    }

    public start(): void {
        this.isStopped = false;
        this.initializeWebSocket();
    }

    public async stop(): Promise<void> {
        const [promise, resolve] = createPromise();
        this.resolveDisconnectingPromise = resolve;

        this.isStopped = true;

        if (this.reconnectTimeoutId !== undefined) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }

        this.webSocket?.close(1000, "WebSocketManager has been stopped");

        // eslint-disable-next-line @typescript-eslint/init-declarations
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(
                    new Error(
                        `Timeout waiting for WebSocket to close after ${WEBSOCKET_DISCONNECT_TIMEOUT_IN_SECONDS} seconds`
                    )
                );
            }, WEBSOCKET_DISCONNECT_TIMEOUT_IN_SECONDS * 1000);
        });

        try {
            while (this.isWebSocketConnected) {
                await Promise.race([promise, timeoutPromise]);
            }
        } catch (error) {
            this.logger.error(
                `Error while waiting for WebSocket to close: ${String(error)}`
            );
            // Force cleanup even if close didn't work
            this.resolveDisconnectingPromise();
            this.resolveDisconnectingPromise = null;
        } finally {
            // Clear timeout to prevent unhandled rejection
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
        }

        await this.waitUntilFinished();
    }

    public async waitUntilFinished(): Promise<void> {
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

        try {
            webSocket.send(JSON.stringify(message));
        } catch (error) {
            this.logger.error(
                `Failed to send handshake message: ${String(error)}`
            );
            throw error;
        }
    }

    public updateLocalCursors(cursorPositions: CursorPositionFromClient): void {
        if (!this.isWebSocketConnected || !this.webSocket) {
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

        try {
            this.webSocket.send(JSON.stringify(message));
            this.logger.debug(
                `Sent cursor positions: ${JSON.stringify(cursorPositions)}`
            );
        } catch (error) {
            this.logger.warn(
                `Failed to send cursor positions: ${String(error)}`
            );
        }
    }

    private initializeWebSocket(): void {
        // Clean up old WebSocket handlers to prevent race conditions
        if (this.webSocket) {
            try {
                // Remove handlers to prevent them from firing after new connection
                this.webSocket.onopen = null;
                this.webSocket.onclose = null;
                this.webSocket.onmessage = null;
                this.webSocket.onerror = null;
                this.webSocket.close();
            } catch (e) {
                this.logger.error(
                    `Failed to close previous WebSocket connection: ${e}`
                );
            }
        }

        const wsUri = new URL(this.settings.getSettings().remoteUri);
        wsUri.protocol = wsUri.protocol === "https" ? "wss" : "ws";
        wsUri.pathname = `/vaults/${this.settings.getSettings().vaultName}/ws`;

        this.logger.info(`Connecting to WebSocket at ${wsUri.toString()}`);

        this.webSocket = new this.webSocketFactoryImplementation(wsUri);

        this.webSocket.onopen = (): void => {
            // Check if we've been stopped while connecting
            if (this.isStopped) {
                this.webSocket?.close(
                    1000,
                    "WebSocketManager was stopped during connection"
                );
                return;
            }
            this.logger.info("WebSocket connection opened");
            this.onWebSocketStatusChanged.trigger(true);
        };

        this.webSocket.onmessage = (event): void => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                const message = JSON.parse(
                    event.data
                ) as WebSocketServerMessage;

                // Track the message handling promise
                const messageHandlingPromise = this.handleWebSocketMessage(
                    message
                )
                    .catch((error: unknown) => {
                        this.logger.error(
                            `Error handling WebSocket message: ${String(error)}`
                        );
                    })
                    .finally(() => {
                        removeFromArray(
                            this.outstandingPromises,
                            messageHandlingPromise
                        );
                    });

                void this.outstandingPromises.push(messageHandlingPromise); // ignore the returned promise
            } catch (error) {
                this.logger.error(
                    `Error parsing WebSocket message: ${String(error)}`
                );
            }
        };

        this.webSocket.onclose = (event): void => {
            this.logger.warn(
                `WebSocket closed with code ${event.code} (${event.reason == "" ? "unknown reason" : event.reason})`
            );
            this.onWebSocketStatusChanged.trigger(false);

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
            await this.onRemoteVaultUpdateReceived.triggerAsync(message);

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        } else if (message.type === "cursorPositions") {
            this.logger.debug(
                `Received cursor positions for ${JSON.stringify(message.clients)}`
            );

            await this.onRemoteCursorsUpdateReceived.triggerAsync(
                message.clients
            );
        } else {
            this.logger.warn(
                `Received unknown message type: ${JSON.stringify(message)}`
            );
        }
    }
}
