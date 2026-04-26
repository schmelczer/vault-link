import type { Logger } from "../tracing/logger";
import type { Settings } from "../persistence/settings";
import type { WebSocketServerMessage } from "./types/WebSocketServerMessage";
import type { WebSocketClientMessage } from "./types/WebSocketClientMessage";
import type { CursorPositionFromClient } from "./types/CursorPositionFromClient";
import type { ClientCursors } from "./types/ClientCursors";
import type { WebSocketVaultUpdate } from "./types/WebSocketVaultUpdate";
import {
    WEBSOCKET_DISCONNECT_TIMEOUT_IN_SECONDS,
    WEBSOCKET_CONNECTION_TIMEOUT_IN_SECONDS
} from "../consts";
import { removeFromArray } from "../utils/remove-from-array";
import { EventListeners } from "../utils/data-structures/event-listeners";
import { awaitAll } from "../utils/await-all";
import { buildVaultUrl } from "./build-vault-url";

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
    private stopPromise: Promise<void> | null = null;
    private reconnectTimeoutId: ReturnType<typeof setTimeout> | undefined;
    private connectionTimeoutId: ReturnType<typeof setTimeout> | undefined;

    private readonly outstandingPromises: Promise<unknown>[] = [];

    private webSocket: WebSocket | undefined;

    public constructor(
        private readonly logger: Logger,
        private readonly settings: Settings,
        private readonly webSocketFactoryImplementation: typeof globalThis.WebSocket = WebSocket
    ) {}

    public get hasOutstandingWork(): boolean {
        return this.outstandingPromises.length > 0;
    }

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
        // Concurrent callers (e.g. destroy() and onSettingsChange) must share
        // the same disconnect; otherwise the second call would overwrite
        // resolveDisconnectingPromise and strand the first caller's await
        // until the timeout rejects.
        this.stopPromise ??= this.performStop().finally(() => {
            this.stopPromise = null;
        });
        await this.stopPromise;
    }

    private async performStop(): Promise<void> {
        const { promise, resolve } = Promise.withResolvers<undefined>();
        this.resolveDisconnectingPromise = (): void => {
            resolve(undefined);
        };

        this.isStopped = true;

        if (this.reconnectTimeoutId !== undefined) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }

        if (this.connectionTimeoutId !== undefined) {
            clearTimeout(this.connectionTimeoutId);
            this.connectionTimeoutId = undefined;
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
            this.resolveDisconnectingPromise?.();
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
                this.webSocket.close(
                    1000,
                    "Closing previous WebSocket connection"
                );
            } catch (e) {
                this.logger.error(
                    `Failed to close previous WebSocket connection: ${e}`
                );
            }
            // Abandon any outstanding handler promises from the previous
            // connection. They'll still resolve in the background, but we
            // no longer want `waitUntilFinished` / `stop` to block on
            // post-reconnect state — and we definitely don't want their
            // results applied against a now-stale socket.
            this.outstandingPromises.length = 0;
        }

        // Build the WS URL through the same vault-URL helper the HTTP client
        // uses so vault-name encoding, trailing-slash stripping, and any path
        // prefix in `remoteUri` stay in sync between transports.
        const wsUri = new URL(buildVaultUrl(this.settings, "/ws"));
        wsUri.protocol = wsUri.protocol.startsWith("https") ? "wss" : "ws";

        this.logger.info(`Connecting to WebSocket at ${wsUri.toString()}`);

        const ws = new this.webSocketFactoryImplementation(wsUri);
        this.webSocket = ws;

        // Set connection timeout to handle cases where server is down and the WebSocket connection won't open.
        // The callback closes the *captured* `ws` rather than `this.webSocket` so a delayed timeout cannot
        // accidentally close a freshly-constructed replacement socket. (Closing the already-closed `ws` is a no-op.)
        this.connectionTimeoutId = setTimeout(() => {
            this.connectionTimeoutId = undefined;
            this.logger.warn(
                `WebSocket connection timeout after ${WEBSOCKET_CONNECTION_TIMEOUT_IN_SECONDS} seconds`
            );
            // Force close to trigger onclose handler which will schedule reconnection
            ws.close(1000, "Connection timeout");
        }, WEBSOCKET_CONNECTION_TIMEOUT_IN_SECONDS * 1000);

        ws.onopen = (): void => {
            if (this.connectionTimeoutId !== undefined) {
                clearTimeout(this.connectionTimeoutId);
                this.connectionTimeoutId = undefined;
            }

            // Check if we've been stopped while connecting
            if (this.isStopped) {
                ws.close(
                    1000,
                    "WebSocketManager was stopped during connection"
                );
                return;
            }
            this.logger.info("WebSocket connection opened");
            this.onWebSocketStatusChanged.trigger(true);
        };

        ws.onmessage = (event): void => {
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

        ws.onerror = (error): void => {
            this.logger.warn(
                `WebSocket error occurred: ${error instanceof ErrorEvent ? error.message : "Unknown error"}`
            );
        };

        ws.onclose = (event): void => {
            if (this.connectionTimeoutId !== undefined) {
                clearTimeout(this.connectionTimeoutId);
                this.connectionTimeoutId = undefined;
            }

            this.logger.warn(
                `WebSocket closed with code ${event.code} (${event.reason == "" ? "unknown reason" : event.reason})`
            );
            this.onWebSocketStatusChanged.trigger(false);

            if (this.isStopped) {
                this.resolveDisconnectingPromise?.();
                this.resolveDisconnectingPromise = null;
            } else {
                const delay =
                    this.settings.getSettings().webSocketRetryIntervalMs;
                this.logger.info(`Reconnecting to WebSocket in ${delay}ms...`);
                this.reconnectTimeoutId = setTimeout(() => {
                    this.reconnectTimeoutId = undefined;
                    this.initializeWebSocket();
                }, delay);
            }
        };
    }

    private async handleWebSocketMessage(
        message: WebSocketServerMessage
    ): Promise<void> {
        switch (message.type) {
            case "vaultUpdate":
                await this.onRemoteVaultUpdateReceived.triggerAsync(message);
                return;
            case "cursorPositions":
                this.logger.debug(
                    `Received cursor positions for ${JSON.stringify(message.clients)}`
                );
                await this.onRemoteCursorsUpdateReceived.triggerAsync(
                    message.clients
                );
                return;
            default:
                this.logger.warn(
                    `Received unknown message type: ${JSON.stringify(message)}`
                );
        }
    }
}
