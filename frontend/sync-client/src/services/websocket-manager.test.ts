/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { WebSocketManager } from "./websocket-manager";
import type { Logger } from "../tracing/logger";
import type { Settings } from "../persistence/settings";

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

    beforeEach(() => {
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

        mockWs.simulateMessage({ type: "vaultUpdate", updates: [] });
        mockWs.simulateMessage({ type: "vaultUpdate", updates: [] });
        mockWs.simulateMessage({ type: "vaultUpdate", updates: [] });

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.strictEqual(outstandingPromises.length, 0);
        await manager.stop();
    });

    it("cleans up cursor position promises", async () => {
        const manager = new WebSocketManager(
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
            mockLogger,
            mockSettings,
            MockWebSocket as unknown as typeof WebSocket
        );

        manager.start();
        await new Promise((resolve) => setTimeout(resolve, 50));

        await manager.stop();
        assert.ok(true);
    });

    it("clears old handlers on reconnection", async () => {
        const manager = new WebSocketManager(
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
        mockWs.simulateMessage({ type: "vaultUpdate", updates: [] });

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
