import type { Mock } from "node:test";
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { FetchController } from "./fetch-controller";
import { Logger } from "../tracing/logger";
import { SyncResetError } from "./sync-reset-error";
import { sleep } from "../utils/sleep";

describe("FetchController", () => {
    const createMockFetch = (
        shouldSleep: boolean
    ): Mock<() => Promise<Response>> =>
        mock.fn(async () => {
            if (shouldSleep) {
                await sleep(30);
            }
            return Promise.resolve(new Response("OK", { status: 200 }));
        });

    beforeEach(() => {
        mock.timers.enable({ apis: ["setTimeout"] });
    });

    afterEach(() => {
        mock.timers.reset();
    });

    it("should allow fetch when canFetch is true", async () => {
        const logger = new Logger();
        const controller = new FetchController(true, logger);
        const mockFetch = createMockFetch(false);
        const controlledFetch = controller.getControlledFetchImplementation(
            logger,
            mockFetch
        );

        const response = await controlledFetch("http://example.com");

        assert.strictEqual(await response.text(), "OK");
        assert.strictEqual(mockFetch.mock.calls.length, 1);
    });

    it("should block fetch until canFetch becomes true", async () => {
        const logger = new Logger();
        const controller = new FetchController(false, logger);
        const mockFetch = createMockFetch(true);
        const controlledFetch = controller.getControlledFetchImplementation(
            logger,
            mockFetch
        );

        const fetchPromise = controlledFetch("http://example.com");
        assert.strictEqual(mockFetch.mock.calls.length, 0);

        controller.canFetch = true;
        await Promise.resolve();
        mock.timers.tick(30);

        const response = await fetchPromise;
        assert.strictEqual(await response.text(), "OK");
        assert.strictEqual(mockFetch.mock.calls.length, 1);
    });

    it("should reject during reset", async () => {
        const logger = new Logger();
        const controller = new FetchController(true, logger);
        const mockFetch = createMockFetch(true);
        const controlledFetch = controller.getControlledFetchImplementation(
            logger,
            mockFetch
        );

        const firstRequest = controlledFetch("http://example.com");
        assert.strictEqual(mockFetch.mock.calls.length, 1);

        controller.startReset();

        const secondRequest = controlledFetch("http://example.com");

        await assert.rejects(
            firstRequest,
            (error: unknown) => error instanceof SyncResetError
        );
        await assert.rejects(
            secondRequest,
            (error: unknown) => error instanceof SyncResetError
        );
        assert.strictEqual(mockFetch.mock.calls.length, 1);
    });

    it("should allow fetch after reset finishes", async () => {
        const logger = new Logger();
        const controller = new FetchController(true, logger);
        const mockFetch = createMockFetch(false);
        const controlledFetch = controller.getControlledFetchImplementation(
            logger,
            mockFetch
        );

        controller.startReset();
        controller.finishReset();

        const response = await controlledFetch("http://example.com");
        assert.strictEqual(await response.text(), "OK");
    });

    it("should defer canFetch changes during reset", async () => {
        const logger = new Logger();
        const controller = new FetchController(false, logger);
        const mockFetch = createMockFetch(true);
        const controlledFetch = controller.getControlledFetchImplementation(
            logger,
            mockFetch
        );

        controller.startReset();
        controller.canFetch = true;

        await assert.rejects(
            async () => controlledFetch("http://example.com"),
            (error: unknown) => error instanceof SyncResetError
        );

        controller.finishReset();

        const fetchPromise = controlledFetch("http://example.com");
        mock.timers.tick(30);

        const response = await fetchPromise;
        assert.strictEqual(await response.text(), "OK");
    });

    it("should handle different input types", async () => {
        const logger = new Logger();
        const controller = new FetchController(true, logger);
        const mockFetch = createMockFetch(false);
        const controlledFetch = controller.getControlledFetchImplementation(
            logger,
            mockFetch
        );

        await controlledFetch("http://example.com");
        await controlledFetch(new URL("http://example.com"));
        await controlledFetch(
            new Request("http://example.com", { method: "POST" })
        );

        assert.strictEqual(mockFetch.mock.calls.length, 3);
    });

    it("should handle fetch errors", async () => {
        const logger = new Logger();
        const controller = new FetchController(true, logger);
        const mockFetch = mock.fn(async () => {
            throw new Error("Network error");
        });
        const controlledFetch = controller.getControlledFetchImplementation(
            logger,
            mockFetch
        );

        await assert.rejects(
            async () => controlledFetch("http://example.com"),
            (error: unknown) =>
                error instanceof Error && error.message === "Network error"
        );
    });

    it("should not create unhandled rejection on reset with no waiting fetches", async () => {
        const logger = new Logger();
        const controller = new FetchController(true, logger);

        controller.startReset();
        mock.timers.tick(10);
        controller.finishReset();
    });
});
