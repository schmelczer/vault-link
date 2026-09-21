/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { createServer } from "node:net";
import { WebSocketManager } from "./websocket-manager";
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

    public constructor(public url: string) {
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
            outstandingPromises: Promise<unknown>[];
        };
        const mockWs = (manager as unknown as { webSocket: MockWebSocket })
            .webSocket;

        mockWs.simulateMessage({
            type: "vaultEvents",
            headEventId: 0,
            events: []
        });
        mockWs.simulateMessage({
            type: "vaultEvents",
            headEventId: 0,
            events: []
        });
        mockWs.simulateMessage({
            type: "vaultEvents",
            headEventId: 0,
            events: []
        });

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.strictEqual(outstandingPromises.length, 0);
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
            outstandingPromises: Promise<unknown>[];
        };
        const mockWs = (manager as unknown as { webSocket: MockWebSocket })
            .webSocket;

        mockWs.simulateMessage({
            type: "cursorPositions",
            clients: [{ deviceId: "other-device", cursors: [] }]
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(outstandingPromises.length, 0);
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

        assert.throws(() => {
            manager.sendHandshakeMessage({
                type: "handshake",
                token: "test",
                deviceId: "test",
                lastSeenVaultUpdateId: null
            });
        });

        await manager.stop();
    });

    it("completes stop with timeout protection", async () => {
        const manager = new WebSocketManager(
            deviceId,
            mockLogger,
            mockSettings,
            MockWebSocket as unknown as typeof WebSocket
        );

        manager.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        await manager.stop();
        assert.ok(true);
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
            type: "vaultEvents",
            headEventId: 0,
            events: []
        });

        await new Promise((resolve) => setTimeout(resolve, 10));

        const { outstandingPromises } = manager as unknown as {
            outstandingPromises: Promise<unknown>[];
        };

        assert.ok(outstandingPromises.length > 0);

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        resolveListener!();
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.strictEqual(outstandingPromises.length, 0);
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
        assert(address && typeof address !== "string");
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        );
        const logger = new Logger();
        const settings = new Settings(
            logger,
            {
                remoteUri: `http://127.0.0.1:${address.port}`,
                webSocketRetryIntervalMs: 10
            },
            async () => {}
        );
        const manager = new WebSocketManager(
            "test",
            logger,
            settings,
            WebSocket
        );
        let closes = 0;
        const disconnected = Promise.withResolvers<void>();
        manager.onWebSocketStatusChanged.add((connected) => {
            if (!connected && ++closes >= 2) disconnected.resolve();
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
            static OPEN = 1;
            constructor(url: string) {
                if (++attempts === failedAttempt)
                    throw new Error("socket allocation failed");
                super(url);
            }
        }
        const logger = new Logger();
        const settings = new Settings(
            logger,
            { remoteUri: "http://test", webSocketRetryIntervalMs: 1000 },
            async () => {}
        );
        const manager = new WebSocketManager(
            "test",
            logger,
            settings,
            FailingSocket as unknown as typeof WebSocket
        );
        try {
            assert.doesNotThrow(() => manager.start());
            context.mock.timers.tick(0);
            if (failedAttempt === 2) {
                const socket = (
                    manager as unknown as { webSocket: MockWebSocket }
                ).webSocket;
                socket.close();
            }
            assert.doesNotThrow(() => context.mock.timers.tick(1000));
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
            static OPEN = 1;
            close() {
                if (closeBehavior === "throws") throw new Error("close failed");
            }
        }
        const logger = new Logger();
        const settings = new Settings(
            logger,
            { remoteUri: "http://test" },
            async () => {}
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
        const stopping = manager.stop();
        context.mock.timers.tick(10_000);
        await stopping;
        assert.equal(manager.isWebSocketConnected, false);
        assert.equal(connected, false);
        socket.simulateMessage({
            type: "vaultEvents",
            headEventId: 0,
            events: []
        });
        await manager.waitUntilFinished();
        assert.equal(delivered, 0);
    });
}

it("a handshake send failure retires the connection without escaping the open callback", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    class BrokenSendSocket extends MockWebSocket {
        static OPEN = 1;
        send() {
            throw new Error("transport closed during open");
        }
    }
    const logger = new Logger();
    const settings = new Settings(
        logger,
        { remoteUri: "http://test" },
        async () => {}
    );
    const manager = new WebSocketManager(
        "test",
        logger,
        settings,
        BrokenSendSocket as unknown as typeof WebSocket
    );
    manager.onWebSocketStatusChanged.add((connected) => {
        if (connected)
            manager.sendHandshakeMessage({
                type: "handshake",
                token: "test",
                deviceId: "test",
                lastSeenVaultUpdateId: 0
            });
    });
    const statuses: boolean[] = [];
    manager.onWebSocketStatusChanged.add((status) => statuses.push(status));
    try {
        manager.start();
        assert.doesNotThrow(() => context.mock.timers.tick(0));
        assert.equal(manager.isWebSocketConnected, false);
        assert.equal(statuses.at(-1), false);
    } finally {
        await manager.stop();
    }
});
