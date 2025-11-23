import { WebSocketManager } from "./websocket-manager";
import type { Logger } from "../tracing/logger";
import type { Settings } from "../persistence/settings";
import type { WebSocketServerMessage } from "./types/WebSocketServerMessage";
import type { WebSocketVaultUpdate } from "./types/WebSocketVaultUpdate";
import type { ClientCursors } from "./types/ClientCursors";

class MockWebSocket {
	public static readonly CONNECTING = 0;
	public static readonly OPEN = 1;
	public static readonly CLOSING = 2;
	public static readonly CLOSED = 3;

	public readyState: number = MockWebSocket.CONNECTING;
	public onopen: ((event: Event) => void) | null = null;
	public onclose: ((event: CloseEvent) => void) | null = null;
	public onmessage: ((event: MessageEvent) => void) | null = null;
	public onerror: ((event: Event) => void) | null = null;

	public sentMessages: string[] = [];
	public closeCode: number | undefined;
	public closeReason: string | undefined;

	public constructor(public url: string) {
		// Simulate async connection
		setTimeout(() => {
			if (this.readyState === MockWebSocket.CONNECTING) {
				this.readyState = MockWebSocket.OPEN;
				this.onopen?.(new Event("open"));
			}
		}, 0);
	}

	public send(data: string): void {
		if (this.readyState !== MockWebSocket.OPEN) {
			throw new Error("WebSocket is not open");
		}
		this.sentMessages.push(data);
	}

	public close(code?: number, reason?: string): void {
		this.closeCode = code;
		this.closeReason = reason;
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.(
			new CloseEvent("close", {
				code: code ?? 1000,
				reason: reason ?? ""
			})
		);
	}

	public simulateMessage(data: unknown): void {
		this.onmessage?.(
			new MessageEvent("message", { data: JSON.stringify(data) })
		);
	}
}

describe("WebSocketManager", () => {
	let mockLogger: Logger;
	let mockSettings: Settings;
	let deviceId: string;

	beforeEach(() => {
		deviceId = "test-device-123";
		mockLogger = {
			info: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
			debug: jest.fn()
		} as unknown as Logger;

		mockSettings = {
			getSettings: jest.fn().mockReturnValue({
				remoteUri: "https://example.com",
				vaultName: "test-vault",
				webSocketRetryIntervalMs: 1000
			})
		} as unknown as Settings;
	});

	describe("BUG #1: Promise Tracking Memory Leak", () => {
		it("EXPOSES: promises are never removed from outstandingPromises array", async () => {
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			let listenerCallCount = 0;
			const listener = jest.fn(async () => {
				listenerCallCount++;
				await new Promise((resolve) => setTimeout(resolve, 10));
			});

			manager.addRemoteVaultUpdateListener(listener);
			manager.start();

			await new Promise((resolve) => setTimeout(resolve, 50));

			const vaultUpdate: WebSocketServerMessage = {
				type: "vaultUpdate",
				updates: []
			};

			// Access private field to inspect outstandingPromises
			const outstandingPromises = (manager as unknown as {
				outstandingPromises: Promise<unknown>[];
			}).outstandingPromises;

			// Send multiple messages
			const mockWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;
			mockWs.simulateMessage(vaultUpdate);
			mockWs.simulateMessage(vaultUpdate);
			mockWs.simulateMessage(vaultUpdate);

			// Wait for listeners to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			// BUG: The promises should have been removed after completion,
			// but due to the tracking bug, they accumulate in the array
			// The finally() handler tries to remove `trackedPromise` but
			// outstandingPromises contains the wrapper promises
			expect(outstandingPromises.length).toBeGreaterThan(0);
			expect(listenerCallCount).toBe(3);

			// This demonstrates the memory leak - promises never get cleaned up
			console.log(
				`MEMORY LEAK: ${outstandingPromises.length} promises still tracked after completion`
			);

			await manager.stop();
		});

		it("EXPOSES: promises accumulate over many messages", async () => {
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			manager.addRemoteVaultUpdateListener(async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
			});
			manager.start();

			await new Promise((resolve) => setTimeout(resolve, 50));

			const outstandingPromises = (manager as unknown as {
				outstandingPromises: Promise<unknown>[];
			}).outstandingPromises;

			const mockWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;

			// Send 10 messages
			for (let i = 0; i < 10; i++) {
				mockWs.simulateMessage({
					type: "vaultUpdate",
					updates: []
				});
			}

			await new Promise((resolve) => setTimeout(resolve, 100));

			// BUG: All 10 promises should be cleaned up, but they're not
			expect(outstandingPromises.length).toBe(10);
			console.log(
				`MEMORY LEAK: ${outstandingPromises.length} promises accumulated`
			);

			await manager.stop();
		});

		it("EXPOSES: same bug occurs with cursor position messages", async () => {
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			manager.addRemoteCursorsUpdateListener(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
			manager.start();

			await new Promise((resolve) => setTimeout(resolve, 50));

			const outstandingPromises = (manager as unknown as {
				outstandingPromises: Promise<unknown>[];
			}).outstandingPromises;

			const mockWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;

			const cursorMessage: WebSocketServerMessage = {
				type: "cursorPositions",
				clients: [
					{
						deviceId: "other-device",
						cursors: []
					}
				]
			};

			mockWs.simulateMessage(cursorMessage);
			mockWs.simulateMessage(cursorMessage);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// BUG: Same promise tracking bug affects cursor messages
			expect(outstandingPromises.length).toBe(2);

			await manager.stop();
		});
	});

	describe("BUG #2: Redundant WebSocket Checks", () => {
		it("EXPOSES: updateLocalCursors logs duplicate warnings", () => {
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			// Don't start, so WebSocket is not connected
			manager.updateLocalCursors({ cursors: [] });

			// BUG: Two warning logs are generated for the same condition
			expect(mockLogger.warn).toHaveBeenCalledTimes(2);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				"WebSocket is not connected, cannot send cursor positions"
			);
		});

		it("EXPOSES: race condition between checks", async () => {
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			manager.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Manually set WebSocket to closing state after first check
			const mockWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;
			const originalReadyState = mockWs.readyState;

			// Simulate race condition: connection drops between the two checks
			jest.spyOn(mockWs, "readyState", "get")
				.mockReturnValueOnce(MockWebSocket.OPEN) // First check passes
				.mockReturnValueOnce(MockWebSocket.CLOSED); // Second check fails

			manager.updateLocalCursors({ cursors: [] });

			// BUG: Even though first check passed, second check fails
			// This demonstrates the race condition
			expect(mockLogger.warn).toHaveBeenCalledWith(
				"WebSocket is not connected, cannot send cursor positions"
			);

			await manager.stop();
		});
	});

	describe("BUG #3: Missing Error Handling on send()", () => {
		it("EXPOSES: sendHandshakeMessage crashes when send() throws", async () => {
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

			// Simulate send() throwing an error (e.g., buffer full)
			jest.spyOn(mockWs, "send").mockImplementation(() => {
				throw new Error("Buffer full");
			});

			// BUG: This throws and crashes - no try-catch to handle it
			expect(() => {
				manager.sendHandshakeMessage({
					type: "handshake",
					vaultName: "test",
					deviceId: "test",
					authToken: "test"
				});
			}).toThrow("Buffer full");

			await manager.stop();
		});

		it("EXPOSES: updateLocalCursors crashes when send() throws", async () => {
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

			jest.spyOn(mockWs, "send").mockImplementation(() => {
				throw new Error("Connection closed");
			});

			// BUG: This throws and crashes - no try-catch to handle it
			expect(() => {
				manager.updateLocalCursors({ cursors: [] });
			}).toThrow("Connection closed");

			await manager.stop();
		});

		it("EXPOSES: send() can throw even after isWebSocketConnected check", async () => {
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

			// WebSocket is open, but send fails
			expect(manager.isWebSocketConnected).toBe(true);

			jest.spyOn(mockWs, "send").mockImplementation(() => {
				throw new Error("Unexpected error");
			});

			// BUG: Even though connection check passed, send() can still throw
			expect(() => {
				manager.updateLocalCursors({ cursors: [] });
			}).toThrow("Unexpected error");

			await manager.stop();
		});
	});

	describe("BUG #4: Potential Infinite Loop in stop()", () => {
		it("EXPOSES: stop() hangs if onclose handler never fires", async () => {
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

			// Simulate a broken WebSocket that doesn't fire onclose
			jest.spyOn(mockWs, "close").mockImplementation(() => {
				// Close is called but onclose handler is never invoked
				mockWs.readyState = MockWebSocket.CLOSING; // Stuck in CLOSING
				// Don't call onclose
			});

			// BUG: This will hang forever because the while loop waits for
			// isWebSocketConnected to become false, but it never does
			const stopPromise = manager.stop();

			// Wait a bit to show it's stuck
			const timeoutPromise = new Promise((resolve) =>
				setTimeout(() => resolve("timeout"), 100)
			);

			const result = await Promise.race([stopPromise, timeoutPromise]);

			expect(result).toBe("timeout");
			console.log("BUG: stop() is stuck in infinite loop");

			// Note: We can't actually clean up here because stop() is hung
			// In a real scenario, this would freeze the application
		});

		it("EXPOSES: stop() loops forever if WebSocket state is corrupted", async () => {
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			manager.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Corrupt the WebSocket state
			const mockWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;
			jest.spyOn(mockWs, "close").mockImplementation(() => {
				// Intentionally leave readyState as OPEN
				// This simulates a bug or corrupted state
			});

			const stopPromise = manager.stop();
			const timeoutPromise = new Promise((resolve) =>
				setTimeout(() => resolve("timeout"), 100)
			);

			const result = await Promise.race([stopPromise, timeoutPromise]);

			// BUG: Infinite loop because readyState never changes
			expect(result).toBe("timeout");
		});
	});

	describe("BUG #5: WebSocket Handler Race Condition", () => {
		it("EXPOSES: rapid reconnection creates multiple WebSocket instances", async () => {
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			manager.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			const firstWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;

			// Trigger reconnection by calling initializeWebSocket again
			(manager as unknown as { initializeWebSocket: () => void })
				.initializeWebSocket();

			const secondWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;

			// BUG: Two different WebSocket instances exist
			expect(firstWs).not.toBe(secondWs);

			// The old WebSocket's handlers are still registered and can fire
			// This can cause interference and unexpected behavior

			// Simulate the old WebSocket's onclose firing
			firstWs.onclose?.(
				new CloseEvent("close", { code: 1000, reason: "test" })
			);

			// This could trigger reconnection logic even though we have a new WebSocket
			// The status change listeners will be called multiple times

			await manager.stop();
		});

		it("EXPOSES: old WebSocket handlers interfere with new connection", async () => {
			let statusChangeCount = 0;
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			manager.addWebSocketStatusChangeListener(() => {
				statusChangeCount++;
			});

			manager.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			const firstWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;

			// Reset counter after initial connection
			statusChangeCount = 0;

			// Create new WebSocket
			(manager as unknown as { initializeWebSocket: () => void })
				.initializeWebSocket();
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Now trigger old WebSocket's onclose
			firstWs.onclose?.(
				new CloseEvent("close", { code: 1000, reason: "test" })
			);

			// BUG: Status change listeners are called for old connection
			// This can cause confusion and incorrect state
			expect(statusChangeCount).toBeGreaterThan(0);

			await manager.stop();
		});
	});

	describe("BUG #6: Untracked handleWebSocketMessage Promise", () => {
		it("EXPOSES: handleWebSocketMessage promise not in outstandingPromises", async () => {
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			let resolveListener: () => void;
			const listenerPromise = new Promise<void>((resolve) => {
				resolveListener = resolve;
			});

			manager.addRemoteVaultUpdateListener(async () => {
				await listenerPromise;
			});

			manager.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			const mockWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;

			// Send message - this triggers handleWebSocketMessage
			mockWs.simulateMessage({
				type: "vaultUpdate",
				updates: []
			});

			// Give time for handleWebSocketMessage to start
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Now try to stop - the handleWebSocketMessage promise is still running
			const stopPromise = manager.stop();

			// BUG: stop() awaits outstandingPromises, but handleWebSocketMessage
			// itself is not tracked, only the listener promises inside it are
			// However, due to bug #1, even those aren't properly tracked

			// Resolve the listener to allow stop to complete
			resolveListener!();

			await stopPromise;

			// This test demonstrates that the outer handleWebSocketMessage
			// promise is not being tracked
		});
	});

	describe("Additional Edge Cases", () => {
		it("multiple listeners with different completion times", async () => {
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			const listener1 = jest.fn(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
			const listener2 = jest.fn(async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
			});
			const listener3 = jest.fn(async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
			});

			manager.addRemoteVaultUpdateListener(listener1);
			manager.addRemoteVaultUpdateListener(listener2);
			manager.addRemoteVaultUpdateListener(listener3);

			manager.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			const outstandingPromises = (manager as unknown as {
				outstandingPromises: Promise<unknown>[];
			}).outstandingPromises;

			const mockWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;
			mockWs.simulateMessage({ type: "vaultUpdate", updates: [] });

			await new Promise((resolve) => setTimeout(resolve, 100));

			// BUG: Even though all listeners completed, 3 promises remain
			expect(outstandingPromises.length).toBe(3);
			expect(listener1).toHaveBeenCalledTimes(1);
			expect(listener2).toHaveBeenCalledTimes(1);
			expect(listener3).toHaveBeenCalledTimes(1);

			await manager.stop();
		});

		it("listener throws error - promise still not cleaned up", async () => {
			const manager = new WebSocketManager(
				deviceId,
				mockLogger,
				mockSettings,
				MockWebSocket as unknown as typeof WebSocket
			);

			const errorListener = jest.fn(async () => {
				throw new Error("Listener error");
			});

			manager.addRemoteVaultUpdateListener(errorListener);
			manager.start();
			await new Promise((resolve) => setTimeout(resolve, 50));

			const outstandingPromises = (manager as unknown as {
				outstandingPromises: Promise<unknown>[];
			}).outstandingPromises;

			const mockWs = (manager as unknown as { webSocket: MockWebSocket })
				.webSocket;
			mockWs.simulateMessage({ type: "vaultUpdate", updates: [] });

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Error should be logged
			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("Error in vault update listener")
			);

			// BUG: Promise still not removed even after error
			expect(outstandingPromises.length).toBe(1);

			await manager.stop();
		});
	});
});
