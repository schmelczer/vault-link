import type { Logger } from "../tracing/logger";
import type { Settings } from "../persistence/settings";
import type { WebSocketServerMessage } from "./types/WebSocketServerMessage";
import type { WebSocketClientMessage } from "./types/WebSocketClientMessage";
import type { CursorPositionFromClient } from "./types/CursorPositionFromClient";
import type { ClientCursors } from "./types/ClientCursors";
import { createPromise } from "../utils/create-promise";
import type { EventBatch } from "./types/EventBatch";
import { WEBSOCKET_DISCONNECT_TIMEOUT_IN_S } from "../consts";
import { removeFromArray } from "../utils/remove-from-array";
import { EventListeners } from "../utils/data-structures/event-listeners";
import { awaitAll } from "../utils/await-all";

export class WebSocketManager {
    public readonly onWebSocketStatusChanged = new EventListeners<
        (isConnected: boolean) => unknown
    >();

    public readonly onRemoteVaultUpdateReceived = new EventListeners<
        (update: EventBatch) => Promise<void>
    >();

    public readonly onRemoteCursorsUpdateReceived = new EventListeners<
        (cursors: ClientCursors[]) => Promise<void>
    >();

    private isStopped = true;
    private resolveDisconnectingPromise: null | (() => unknown) = null;
    private receiveTimeoutId: ReturnType<typeof setTimeout> | undefined;
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
            this.webSocket !== undefined &&
            this.webSocket.readyState ===
                this.webSocketFactoryImplementation.OPEN
        );
    }

    public start(): void {
        if (!this.isStopped) return;
        this.isStopped = false;
        this.initializeWebSocket();
    }

    public async stop(): Promise<void> {
        const [promise, resolve] = createPromise();
        this.resolveDisconnectingPromise = resolve;

        this.isStopped = true;
        clearTimeout(this.receiveTimeoutId);

        if (this.reconnectTimeoutId !== undefined) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }

        const socket = this.webSocket;
        try {
            socket?.close(1000, "WebSocketManager has been stopped");
        } catch (error) {
            this.logger.warn(`Failed to close WebSocket: ${String(error)}`);
            if (socket) this.reconnect(socket);
        }

        // eslint-disable-next-line @typescript-eslint/init-declarations
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(
                    new Error(
                        `Timeout waiting for WebSocket to close after ${WEBSOCKET_DISCONNECT_TIMEOUT_IN_S} seconds`
                    )
                );
            }, WEBSOCKET_DISCONNECT_TIMEOUT_IN_S * 1000);
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
            // A throwing, silent or timed-out close must still fence callbacks
            // before a stopped client can release its state or restart.
            if (socket) this.reconnect(socket);
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
            this.reconnect(webSocket);
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

    private expectResponse(socket: WebSocket): void {
        clearTimeout(this.receiveTimeoutId);
        // Cursor heartbeats are acknowledged every 15 seconds, including when
        // there are no open editors. An OPEN TCP socket alone proves nothing.
        this.receiveTimeoutId = setTimeout(() => {
            if (this.webSocket !== socket || this.isStopped) return;
            this.logger.warn("WebSocket receive deadline expired");
            this.reconnect(socket);
        }, 45_000);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Browser timers have no unref method.
        this.receiveTimeoutId.unref?.();
    }

    private reconnect(socket: WebSocket): void {
        if (this.webSocket !== socket) return;
        clearTimeout(this.receiveTimeoutId);
        socket.onopen = null;
        socket.onclose = null;
        socket.onmessage = null;
        socket.onerror = (): void => {
            /* Retired transports may still emit errors. */
        };
        this.webSocket = undefined;
        this.onWebSocketStatusChanged.trigger(false);
        try {
            socket.close();
        } catch {
            /* The transport may already be gone. */
        }
        if (this.isStopped) {
            this.resolveDisconnectingPromise?.();
            this.resolveDisconnectingPromise = null;
        } else {
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (this.isStopped) return;
        clearTimeout(this.reconnectTimeoutId);
        this.reconnectTimeoutId = setTimeout(() => {
            this.reconnectTimeoutId = undefined;
            this.initializeWebSocket();
        }, this.settings.getSettings().webSocketRetryIntervalMs);
    }

    private initializeWebSocket(): void {
        if (this.isStopped) return;
        try {
            this.openWebSocket();
        } catch (error) {
            this.logger.warn(`Cannot initialize WebSocket: ${String(error)}`);
            this.webSocket = undefined;
            clearTimeout(this.receiveTimeoutId);
            this.onWebSocketStatusChanged.trigger(false);
            this.scheduleReconnect();
        }
    }

    private openWebSocket(): void {
        // Clean up old WebSocket handlers to prevent race conditions
        if (this.webSocket) {
            try {
                // Remove handlers to prevent them from firing after new connection
                this.webSocket.onopen = null;
                this.webSocket.onclose = null;
                this.webSocket.onmessage = null;
                this.webSocket.onerror = (): void => {
                    /* Retired transports may still emit errors. */
                };
                this.webSocket.close();
            } catch (e) {
                this.logger.error(
                    `Failed to close previous WebSocket connection: ${e}`
                );
            }
        }

        const { remoteUri, vaultName } = this.settings.getSettings();
        const wsUri = new URL(remoteUri);
        wsUri.protocol = wsUri.protocol === "https:" ? "wss:" : "ws:";
        wsUri.pathname = `${wsUri.pathname.replace(/\/$/u, "")}/vaults/${encodeURIComponent(vaultName)}/ws`;
        wsUri.search = "";
        wsUri.hash = "";

        this.logger.info(`Connecting to WebSocket at ${wsUri.toString()}`);

        const socket = new this.webSocketFactoryImplementation(wsUri);
        this.webSocket = socket;
        this.expectResponse(socket);

        this.webSocket.onerror = (): void => {
            this.logger.warn("WebSocket transport error");
            this.reconnect(socket);
        };

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
            try {
                this.onWebSocketStatusChanged.trigger(true);
                // A handshake failure can retire this socket from inside an
                // observer. Finish delivery with its actual connection state.
                if (this.webSocket !== socket)
                    this.onWebSocketStatusChanged.trigger(false);
            } catch (error) {
                this.logger.warn(
                    `WebSocket handshake failed: ${String(error)}`
                );
                this.reconnect(socket);
            }
        };

        this.webSocket.onmessage = (event): void => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                const message = JSON.parse(
                    event.data
                ) as WebSocketServerMessage;

                if (["vaultEvents", "cursorPositions"].includes(message.type))
                    this.expectResponse(socket);
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
            this.reconnect(socket);
        };
    }

    private async handleWebSocketMessage(
        message: WebSocketServerMessage
    ): Promise<void> {
        if (message.type === "vaultEvents") {
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
