import { rateLimit } from "./rate-limit";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";

describe("rateLimit", () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout"] });
	});

	afterEach(() => {
		mock.timers.reset();
	});

	it("should call the function immediately on first invocation", async () => {
		const mockFn = mock.fn<() => Promise<string>>();
		mockFn.mock.mockImplementation(async () => "result");
		const rateLimited = rateLimit(mockFn, 100);

		const promise = rateLimited();
		assert.strictEqual(mockFn.mock.callCount(), 1);

		await promise;
	});

	it("should call the function again after the interval has passed", async () => {
		const mockFn = mock.fn<(value: number) => Promise<string>>();
		mockFn.mock.mockImplementation(async () => "result");

		const rateLimited = rateLimit(mockFn, 100);

		const promise1 = rateLimited(1);
		await promise1;

		mock.timers.tick(200);

		const promise2 = rateLimited(2);
		await promise2;

		assert.strictEqual(mockFn.mock.callCount(), 2);
		assert.deepStrictEqual(mockFn.mock.calls[1].arguments, [2]);
	});

	it("should use the most recent arguments if multiple calls are made within interval", async () => {
		const mockFn = mock.fn<(value: string) => Promise<string>>();
		mockFn.mock.mockImplementation(async (val: string) => `${val}-result`);
		const rateLimited = rateLimit(mockFn, 100);

		const promise1 = rateLimited("first");
		mock.timers.tick(10);
		const promise2 = rateLimited("second");
		mock.timers.tick(10);
		const promise3 = rateLimited("third");

		mock.timers.tick(1000);

		assert.strictEqual(await promise1, "first-result");
		assert.strictEqual(await promise2, "third-result");
		assert.strictEqual(await promise3, undefined);

		assert.strictEqual(mockFn.mock.callCount(), 2);
		assert.deepStrictEqual(mockFn.mock.calls[0].arguments, ["first"]);
		assert.deepStrictEqual(mockFn.mock.calls[1].arguments, ["third"]);
	});
});
