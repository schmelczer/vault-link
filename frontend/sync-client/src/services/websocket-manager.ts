import type { Logger } from "../tracing/logger";
import type { Settings } from "../persistence/settings";
import type { WebSocketServerMessage } from "./types/WebSocketServerMessage";
import type { WebSocketClientMessage } from "./types/WebSocketClientMessage";
import type { CursorPositionFromClient } from "./types/CursorPositionFromClient";
import type { ClientCursors } from "./types/ClientCursors";
import { createPromise } from "../utils/create-promise";
import type { WebSocketVaultUpdate } from "./types/WebSocketVaultUpdate";
import {
    WEBSOCKET_DISCONNECT_TIMEOUT_IN_SECONDS,
    WEBSOCKET_CONNECTION_TIMEOUT_IN_SECONDS
} from "../consts";
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
    private connectionTimeoutId: ReturnType<typeof setTimeout> | undefined;

    private readonly outstandingPromises: Promise<unknown>[] = [];

    /**
     * Chains WebSocket message processing so only one message is handled
     * at a time. Without this, a burst of messages would create many
     * concurrent sync operations (each calling scheduleSyncForOfflineChanges
     * and processing documents in parallel).
     */
    private messageProcessingChain: Promise<void> = Promise.resolve();

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
            this.resolveDisconnectingPromise();
            this.resolveDisconnectingPromise = null;
        } finally {
            // Clear timeout to prevent unhandled rejection
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
        }

        // Wait for any already-enqueued message handlers to finish.
        // The isStopped guard in onmessage prevents NEW messages from
        // being enqueued, but handlers that were chained before stop()
        // set the flag may still be in flight.
        await this.messageProcessingChain;
        await this.waitUntilFinished();
    }

    public async waitUntilFinished(): Promise<void> {
        await awaitAll(this.outstandingPromises);
    }

    public hasOutstandingWork(): boolean {
        return this.outstandingPromises.length > 0;
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
        }

        const wsUri = new URL(this.settings.getSettings().remoteUri);
        wsUri.protocol = wsUri.protocol === "https" ? "wss" : "ws";
        wsUri.pathname = `/vaults/${this.settings.getSettings().vaultName}/ws`;

        this.logger.info(`Connecting to WebSocket at ${wsUri.toString()}`);

        this.webSocket = new this.webSocketFactoryImplementation(wsUri);

        // Set connection timeout to handle cases where server is down and the WebSocket connection won't open
        this.connectionTimeoutId = setTimeout(() => {
            this.connectionTimeoutId = undefined;
            this.logger.warn(
                `WebSocket connection timeout after ${WEBSOCKET_CONNECTION_TIMEOUT_IN_SECONDS} seconds`
            );
            // Force close to trigger onclose handler which will schedule reconnection
            this.webSocket?.close(1000, "Connection timeout");
        }, WEBSOCKET_CONNECTION_TIMEOUT_IN_SECONDS * 1000);

        this.webSocket.onopen = (): void => {
            if (this.connectionTimeoutId !== undefined) {
                clearTimeout(this.connectionTimeoutId);
                this.connectionTimeoutId = undefined;
            }

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
            // Discard messages received after stop() has been called.
            // Without this guard, messages arriving between close()
            // and the onclose event would be enqueued into
            // messageProcessingChain and execute after stop() returns.
            if (this.isStopped) {
                return;
            }

            try {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                const message = JSON.parse(
                    event.data
                ) as WebSocketServerMessage;

                // Cursor updates are pure reads (update an in-memory map) —
                // handle immediately without blocking behind vault update
                // processing. This avoids cursor latency during large syncs.
                if (message.type === "cursorPositions") {
                    this.logger.debug(
                        `Received cursor positions for ${JSON.stringify(message.clients)}`
                    );
                    const cursorPromise =
                        this.onRemoteCursorsUpdateReceived
                            .triggerAsync(message.clients)
                            .catch((error: unknown) => {
                                this.logger.error(
                                    `Error handling cursor update: ${String(error)}`
                                );
                            });
                    // Track for waitUntilFinished / hasOutstandingWork
                    this.outstandingPromises.push(cursorPromise);
                    void cursorPromise.finally(() => {
                        removeFromArray(
                            this.outstandingPromises,
                            cursorPromise
                        );
                    });
                    return;
                }

                // Vault updates require serialization: each waits for the
                // previous one to finish. This provides back-pressure so a
                // burst of WebSocket messages doesn't create unbounded
                // concurrent sync operations.
                //
                // Read-reassign safety: we read messageProcessingChain,
                // chain a .then() onto it, and assign the resulting promise
                // back. This is safe because JavaScript is single-threaded:
                // no other code can run between the read and the assignment.
                // The next onmessage invocation will see the updated chain
                // and append after this handler, preserving FIFO order.
                this.messageProcessingChain = this.messageProcessingChain
                    .then(async () => this.handleWebSocketMessage(message))
                    .catch((error: unknown) => {
                        this.logger.error(
                            `Error handling WebSocket message: ${String(error)}`
                        );
                    });

                const messageHandlingPromise = this.messageProcessingChain;

                // Track the promise for waitUntilFinished / hasOutstandingWork
                this.outstandingPromises.push(messageHandlingPromise);
                void messageHandlingPromise.finally(() => {
                    removeFromArray(
                        this.outstandingPromises,
                        messageHandlingPromise
                    );
                });
            } catch (error) {
                this.logger.error(
                    `Error parsing WebSocket message: ${String(error)}`
                );
            }
        };

        this.webSocket.onerror = (error): void => {
            this.logger.warn(
                `WebSocket error occurred: ${error instanceof ErrorEvent ? error.message : "Unknown error"}`
            );
        };

        this.webSocket.onclose = (event): void => {
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
        if (message.type === "vaultUpdate") {
            await this.onRemoteVaultUpdateReceived.triggerAsync(message);
        } else {
            // Cursor messages are handled inline in onmessage (not chained)
            this.logger.warn(
                `Received unknown message type: ${JSON.stringify(message)}`
            );
        }
    }
}
