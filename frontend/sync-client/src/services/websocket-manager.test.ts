/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { createServer } from "node:net";
import { WebSocketManager } from "./websocket-manager";
import { WEBSOCKET_RECEIVE_TIMEOUT_MS } from "../consts";
import { Logger } from "../tracing/logger";
import { Settings } from "../persistence/settings";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WebSocket = require("ws") as typeof globalThis.WebSocket;

class MockCloseEvent extends Event {
    public code: number;
    public reason: string;

    public constructor(
        type: string,
        options: { code: number; reason: string }
    ) {
        super(type);
        this.code = options.code;
        this.reason = options.reason;
    }
}

class MockMessageEvent extends Event {
    public data: string;

    public constructor(type: string, options: { data: string }) {
        super(type);
        this.data = options.data;
    }
}

class MockWebSocket {
    public readyState: number = WebSocket.CONNECTING;
    public onopen: ((event: Event) => void) | null = null;
    public onclose: ((event: MockCloseEvent) => void) | null = null;
    public onmessage: ((event: MockMessageEvent) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;

    public sentMessages: string[] = [];

    public constructor(public url: string | URL) {
        setTimeout(() => {
            if (this.readyState === WebSocket.CONNECTING) {
                this.readyState = WebSocket.OPEN;
                this.onopen?.(new Event("open"));
            }
        }, 0);
    }

    public send(data: string): void {
        if (this.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket is not open");
        }

        this.sentMessages.push(data);
    }

    public close(code?: number, reason?: string): void {
        this.readyState = WebSocket.CLOSED;
        this.onclose?.(
            new MockCloseEvent("close", {
                code: code ?? 1000,
                reason: reason ?? ""
            })
        );
    }

    public simulateMessage(data: unknown): void {
        this.onmessage?.(
            new MockMessageEvent("message", { data: JSON.stringify(data) })
        );
    }
}

type MockFn<T extends (...args: unknown[]) => unknown> = T & {
    calls: Parameters<T>[];
};

function createMockFn<T extends (...args: unknown[]) => unknown>(
    implementation?: T
): MockFn<T> {
    const calls: Parameters<T>[] = [];
    const mockFn = ((...args: Parameters<T>) => {
        calls.push(args);
        return implementation?.(...args);
    }) as unknown as MockFn<T>;
    mockFn.calls = calls;
    return mockFn;
}

describe("WebSocketManager", () => {
    let mockLogger: Logger = undefined as unknown as Logger;
    let mockSettings: Settings = undefined as unknown as Settings;
    let deviceId = "test-device-123";

    beforeEach(() => {
        deviceId = "test-device-123";
        const noop = (): void => {
            // Intentionally empty for mock
        };

        mockLogger = {
            info: createMockFn(noop),
            warn: createMockFn(noop),
            error: createMockFn(noop),
            debug: createMockFn(noop)
        } as unknown as Logger;

        mockSettings = {
            getSettings: () => ({
                remoteUri: "https://example.com",
                vaultName: "test-vault",
                webSocketRetryIntervalMs: 1000
            })
        } as unknown as Settings;
    });

    it("cleans up promises after message handling", async () => {
        const manager = new WebSocketManager(
            deviceId,
            mockLogger,
            mockSettings,
            MockWebSocket as unknown as typeof WebSocket
        );

        manager.onRemoteVaultUpdateReceived.add(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
        manager.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const { outstandingPromises } = manager as unknown as {
            outstandingPromises: Set<Promise<void>>;
        };
        const mockWs = (manager as unknown as { webSocket: MockWebSocket })
            .webSocket;

        mockWs.simulateMessage({
            type: "vaultChanged"
        });
        mockWs.simulateMessage({
            type: "vaultChanged"
        });
        mockWs.simulateMessage({
            type: "vaultChanged"
        });

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.strictEqual(outstandingPromises.size, 0);
        await manager.stop();
    });

    it("cleans up cursor position promises", async () => {
        const manager = new WebSocketManager(
            deviceId,
            mockLogger,
            mockSettings,
            MockWebSocket as unknown as typeof WebSocket
        );

        manager.onRemoteCursorsUpdateReceived.add(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
        manager.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const { outstandingPromises } = manager as unknown as {
            outstandingPromises: Set<Promise<void>>;
        };
        const mockWs = (manager as unknown as { webSocket: MockWebSocket })
            .webSocket;

        mockWs.simulateMessage({
            type: "cursorPositions",
            clients: [{ deviceId: "other-device", cursors: [] }]
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(outstandingPromises.size, 0);
        await manager.stop();
    });

    it("logs handshake send errors", async () => {
        const manager = new WebSocketManager(
            deviceId,
            mockLogger,
            mockSettings,
            MockWebSocket as unknown as typeof WebSocket
        );

        manager.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const mockWs = (manager as unknown as { webSocket: MockWebSocket })
            .webSocket;
        mockWs.send = (): void => {
            throw new Error("Buffer full");
        };

        assert.doesNotThrow(() => mockWs.onopen?.(new Event("open")));
        assert.equal(manager.isWebSocketConnected, false);
        assert(
            (
                mockLogger.warn as typeof mockLogger.warn & {
                    calls: [string][];
                }
            ).calls.some(([message]) =>
                message.includes("WebSocket handshake failed")
            )
        );

        await manager.stop();
    });

    it("completes stop after retiring the socket", async () => {
        const manager = new WebSocketManager(
            deviceId,
            mockLogger,
            mockSettings,
            MockWebSocket as unknown as typeof WebSocket
        );

        manager.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        await manager.stop();
        assert.equal(manager.isWebSocketConnected, false);
    });

    it("uses a secure URL, preserves the configured prefix, and encodes the vault", async () => {
        mockSettings = {
            getSettings: () => ({
                remoteUri: "https://example.com/sync/",
                vaultName: "team/a ?",
                webSocketRetryIntervalMs: 1000
            })
        } as unknown as Settings;
        const manager = new WebSocketManager(
            deviceId,
            mockLogger,
            mockSettings,
            MockWebSocket as unknown as typeof WebSocket
        );

        manager.start();
        const mockWs = (manager as unknown as { webSocket: MockWebSocket })
            .webSocket;
        assert.strictEqual(
            String(mockWs.url),
            "wss://example.com/sync/vaults/team%2Fa%20%3F/ws"
        );
        await manager.stop();
    });

    it("clears old handlers on reconnection", async () => {
        const manager = new WebSocketManager(
            deviceId,
            mockLogger,
            mockSettings,
            MockWebSocket as unknown as typeof WebSocket
        );

        let statusChangeCount = 0;
        manager.onWebSocketStatusChanged.add(() => {
            statusChangeCount++;
        });

        manager.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const firstWs = (manager as unknown as { webSocket: MockWebSocket })
            .webSocket;

        statusChangeCount = 0;

        (
            manager as unknown as { initializeWebSocket: () => void }
        ).initializeWebSocket();
        await new Promise((resolve) => setTimeout(resolve, 50));

        statusChangeCount = 0;

        // Old handler should be cleared
        firstWs.onclose?.(
            new MockCloseEvent("close", { code: 1000, reason: "test" })
        );

        assert.strictEqual(statusChangeCount, 0);
        await manager.stop();
    });

    it("tracks message handling promises", async () => {
        const manager = new WebSocketManager(
            deviceId,
            mockLogger,
            mockSettings,
            MockWebSocket as unknown as typeof WebSocket
        );

        // eslint-disable-next-line @typescript-eslint/init-declarations
        let resolveListener: () => void;
        const listenerPromise = new Promise<void>((resolve) => {
            resolveListener = resolve;
        });

        manager.onRemoteVaultUpdateReceived.add(async () => {
            await listenerPromise;
        });

        manager.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const mockWs = (manager as unknown as { webSocket: MockWebSocket })
            .webSocket;
        mockWs.simulateMessage({
            type: "vaultChanged"
        });

        await new Promise((resolve) => setTimeout(resolve, 10));

        const { outstandingPromises } = manager as unknown as {
            outstandingPromises: Set<Promise<void>>;
        };

        assert.ok(outstandingPromises.size > 0);

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        resolveListener!();
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.strictEqual(outstandingPromises.size, 0);
        await manager.stop();
    });
});

it(
    "refused WebSocket connections and replacing a connecting socket do not emit unhandled errors",
    { timeout: 5_000 },
    async () => {
        const server = createServer();
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve)
        );
        const address = server.address();
        assert(address !== null && typeof address !== "string");
        await new Promise<void>((resolve, reject) =>
            server.close((error) => {
                if (error !== undefined) {
                    reject(error);
                } else {
                    resolve();
                }
            })
        );
        const logger = new Logger();
        const settings = new Settings(
            logger,
            {
                remoteUri: `http://127.0.0.1:${address.port}`,
                webSocketRetryIntervalMs: 10
            },
            async () => undefined
        );
        const manager = new WebSocketManager(
            "test",
            logger,
            settings,
            WebSocket
        );
        let closes = 0;
        const disconnected = Promise.withResolvers<undefined>();
        manager.onWebSocketStatusChanged.add((connected) => {
            if (!connected && ++closes >= 2) {
                disconnected.resolve(undefined);
            }
        });
        try {
            manager.start();
            manager.start();
            await disconnected.promise;
            assert.equal(manager.isWebSocketConnected, false);
        } finally {
            await manager.stop();
        }
    }
);

for (const failedAttempt of [1, 2]) {
    it(`recovers from a WebSocket constructor failure on attempt ${failedAttempt}`, async (context) => {
        context.mock.timers.enable({ apis: ["setTimeout"] });
        let attempts = 0;
        class FailingSocket extends MockWebSocket {
            public static OPEN = 1;
            public constructor(url: string) {
                if (++attempts === failedAttempt) {
                    throw new Error("socket allocation failed");
                }

                super(url);
            }
        }
        const logger = new Logger();
        const settings = new Settings(
            logger,
            { remoteUri: "http://test", webSocketRetryIntervalMs: 1000 },
            async () => undefined
        );
        const manager = new WebSocketManager(
            "test",
            logger,
            settings,
            FailingSocket as unknown as typeof WebSocket
        );
        try {
            assert.doesNotThrow(() => {
                manager.start();
            });
            context.mock.timers.tick(0);
            if (failedAttempt === 2) {
                const socket = (
                    manager as unknown as { webSocket: MockWebSocket }
                ).webSocket;
                socket.close();
            }

            assert.doesNotThrow(() => {
                context.mock.timers.tick(1000);
            });
            context.mock.timers.tick(1000);
            assert.equal(attempts, failedAttempt + 1);
            assert.equal(manager.isWebSocketConnected, true);
        } finally {
            await manager.stop();
        }
    });
}

for (const closeBehavior of ["throws", "stays open"]) {
    it(`stop retires a socket even when close ${closeBehavior}`, async (context) => {
        context.mock.timers.enable({ apis: ["setTimeout"] });
        class BrokenCloseSocket extends MockWebSocket {
            public static OPEN = 1;
            public close(): void {
                if (closeBehavior === "throws") {
                    throw new Error("close failed");
                }
            }
        }
        const logger = new Logger();
        const settings = new Settings(
            logger,
            { remoteUri: "http://test" },
            async () => undefined
        );
        const manager = new WebSocketManager(
            "test",
            logger,
            settings,
            BrokenCloseSocket as unknown as typeof WebSocket
        );
        let connected = false,
            delivered = 0;
        manager.onWebSocketStatusChanged.add((status) => {
            connected = status;
        });
        manager.onRemoteVaultUpdateReceived.add(async () => {
            delivered++;
        });
        manager.start();
        context.mock.timers.tick(0);
        const socket = (manager as unknown as { webSocket: MockWebSocket })
            .webSocket;
        const delayedMessage = socket.onmessage;
        await manager.stop(); // No close event or timer advance is needed.
        assert.equal(manager.isWebSocketConnected, false);
        assert.equal(connected, false);
        socket.simulateMessage({
            type: "vaultChanged"
        });
        delayedMessage?.(
            new MockMessageEvent("message", {
                data: JSON.stringify({ type: "vaultChanged" })
            })
        );
        await manager.waitUntilFinished();
        assert.equal(delivered, 0);
    });
}

it("stop retires the socket immediately but drains messages already being handled", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const logger = new Logger();
    const manager = new WebSocketManager(
        "device",
        logger,
        new Settings(
            logger,
            { remoteUri: "http://test", token: "test-token" },
            async () => undefined
        ),
        MockWebSocket as unknown as typeof WebSocket
    );
    const release = Promise.withResolvers<undefined>();
    context.after(async () => {
        release.resolve(undefined);
        await manager.stop();
    });
    manager.start();
    context.mock.timers.tick(0);
    const socket = (manager as unknown as { webSocket: MockWebSocket })
        .webSocket;
    assert.deepEqual(JSON.parse(socket.sentMessages[0] ?? ""), {
        type: "handshake",
        token: "test-token",
        deviceId: "device"
    });
    manager.onRemoteVaultUpdateReceived.add(async () => release.promise);
    socket.simulateMessage({ type: "vaultChanged" });
    let finished = false;
    const stopping = manager.stop().then(() => {
        finished = true;
    });
    assert.equal(manager.isWebSocketConnected, false);
    assert.equal(socket.onmessage, null);
    await Promise.resolve();
    assert(!finished);
    release.resolve(undefined);
    await stopping;
    assert(finished);
});

it("a handshake send failure retires the connection without escaping the open callback", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    class BrokenSendSocket extends MockWebSocket {
        public static OPEN = 1;
        public send(): void {
            throw new Error("transport closed during open");
        }
    }
    const logger = new Logger();
    const settings = new Settings(
        logger,
        { remoteUri: "http://test" },
        async () => undefined
    );
    const manager = new WebSocketManager(
        "test",
        logger,
        settings,
        BrokenSendSocket as unknown as typeof WebSocket
    );
    const statuses: boolean[] = [];
    manager.onWebSocketStatusChanged.add((status) => statuses.push(status));
    try {
        manager.start();
        assert.doesNotThrow(() => {
            context.mock.timers.tick(0);
        });
        assert.equal(manager.isWebSocketConnected, false);
        assert.equal(statuses.at(-1), false);
        assert(
            !statuses.includes(true),
            "a failed handshake must never announce a connection"
        );
    } finally {
        await manager.stop();
    }
});

it("reconnects a connection that stops delivering messages", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let attempts = 0;
    class CountingSocket extends MockWebSocket {
        public static OPEN = 1;
        public constructor(url: string) {
            super(url);
            attempts++;
        }
    }
    const logger = new Logger();
    const settings = new Settings(
        logger,
        { remoteUri: "http://test", webSocketRetryIntervalMs: 1000 },
        async () => undefined
    );
    const manager = new WebSocketManager(
        "test",
        logger,
        settings,
        CountingSocket as unknown as typeof WebSocket
    );
    const statuses: boolean[] = [];
    manager.onWebSocketStatusChanged.add((status) => statuses.push(status));
    try {
        manager.start();
        context.mock.timers.tick(0);
        assert.equal(manager.isWebSocketConnected, true);
        assert.equal(attempts, 1);

        const silentSocket = (
            manager as unknown as { webSocket: MockWebSocket }
        ).webSocket;
        context.mock.timers.tick(WEBSOCKET_RECEIVE_TIMEOUT_MS);
        assert.equal(manager.isWebSocketConnected, false);
        assert.equal(statuses.at(-1), false);
        assert.equal(silentSocket.onmessage, null);

        context.mock.timers.tick(1000);
        context.mock.timers.tick(0);
        assert.equal(attempts, 2);
        assert.equal(manager.isWebSocketConnected, true);
    } finally {
        await manager.stop();
    }
});

it("does not reconnect while messages keep arriving before the deadline", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let attempts = 0;
    class CountingSocket extends MockWebSocket {
        public static OPEN = 1;
        public constructor(url: string) {
            super(url);
            attempts++;
        }
    }
    const logger = new Logger();
    const settings = new Settings(
        logger,
        { remoteUri: "http://test", webSocketRetryIntervalMs: 1000 },
        async () => undefined
    );
    const manager = new WebSocketManager(
        "test",
        logger,
        settings,
        CountingSocket as unknown as typeof WebSocket
    );
    let disconnected = 0;
    manager.onWebSocketStatusChanged.add((status) => {
        if (!status) {
            disconnected++;
        }
    });
    try {
        manager.start();
        context.mock.timers.tick(0);
        const socket = (manager as unknown as { webSocket: MockWebSocket })
            .webSocket;
        assert.equal(attempts, 1);

        context.mock.timers.tick(10_000);
        socket.simulateMessage({ type: "vaultChanged" });
        context.mock.timers.tick(10_000);
        socket.simulateMessage({ type: "cursorPositions", clients: [] });
        context.mock.timers.tick(WEBSOCKET_RECEIVE_TIMEOUT_MS - 20_000);
        assert.equal(manager.isWebSocketConnected, true);
        assert.equal(disconnected, 0);
        assert.equal(attempts, 1);
    } finally {
        await manager.stop();
    }
});
