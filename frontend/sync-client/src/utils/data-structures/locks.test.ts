import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { Logger } from "../../tracing/logger";
import type { RelativePath } from "../../persistence/database";
import { Locks } from "./locks";
import { awaitAll } from "../await-all";
import { sleep } from "../sleep";

describe("withLock", () => {
	const testPath: RelativePath = "test/document/path";
	const testPath2: RelativePath = "test/document/path2";
	const logger = new Logger();

	// eslint-disable-next-line @typescript-eslint/init-declarations
	let locks: Locks<RelativePath>;

	beforeEach(() => {
		locks = new Locks<RelativePath>(logger);
	});

	it("should execute function with single key lock", async () => {
		let executionCount = 0;
		const result = await locks.withLock(testPath, () => {
			executionCount++;
			return "success";
		});

		assert.strictEqual(result, "success");
		assert.strictEqual(executionCount, 1);
	});

	it("should execute async function with single key lock", async () => {
		let executionCount = 0;
		const result = await locks.withLock(testPath, async () => {
			executionCount++;
			await sleep(10);
			return "async-success";
		});

		assert.strictEqual(result, "async-success");
		assert.strictEqual(executionCount, 1);
	});

	it("should execute function with multiple key locks", async () => {
		let executionCount = 0;
		const result = await locks.withLock([testPath, testPath2], () => {
			executionCount++;
			return "multi-success";
		});

		assert.strictEqual(result, "multi-success");
		assert.strictEqual(executionCount, 1);
	});

	it("should sort multiple keys to prevent deadlocks", async () => {
		const executionOrder: string[] = [];

		// Start two concurrent operations with keys in different orders
		const promise1 = locks.withLock([testPath2, testPath], async () => {
			executionOrder.push("operation1-start");
			await sleep(50);
			executionOrder.push("operation1-end");
			return "result1";
		});

		const promise2 = locks.withLock([testPath, testPath2], async () => {
			executionOrder.push("operation2-start");
			await sleep(50);
			executionOrder.push("operation2-end");
			return "result2";
		});

		const [result1, result2] = await awaitAll([promise1, promise2]);

		assert.strictEqual(result1, "result1");
		assert.strictEqual(result2, "result2");
		// One operation should complete entirely before the other starts
		assert.deepStrictEqual(executionOrder, [
			"operation1-start",
			"operation1-end",
			"operation2-start",
			"operation2-end"
		]);
	});

	it("should serialize access to same key", async () => {
		const executionOrder: string[] = [];

		const promise1 = locks.withLock(testPath, async () => {
			executionOrder.push("operation1-start");
			await sleep(50);
			executionOrder.push("operation1-end");
			return "result1";
		});

		const promise2 = locks.withLock(testPath, async () => {
			executionOrder.push("operation2-start");
			await sleep(30);
			executionOrder.push("operation2-end");
			return "result2";
		});

		const [result1, result2] = await awaitAll([promise1, promise2]);

		assert.strictEqual(result1, "result1");
		assert.strictEqual(result2, "result2");
		assert.deepStrictEqual(executionOrder, [
			"operation1-start",
			"operation1-end",
			"operation2-start",
			"operation2-end"
		]);
	});

	it("should allow concurrent access to different keys", async () => {
		const executionOrder: string[] = [];

		const promise1 = locks.withLock(testPath, async () => {
			executionOrder.push("operation1-start");
			await sleep(50);

			executionOrder.push("operation1-end");
			return "result1";
		});

		const promise2 = locks.withLock(testPath2, async () => {
			executionOrder.push("operation2-start");
			await sleep(30);
			executionOrder.push("operation2-end");
			return "result2";
		});

		const [result1, result2] = await awaitAll([promise1, promise2]);

		assert.strictEqual(result1, "result1");
		assert.strictEqual(result2, "result2");
		// Both operations should run concurrently
		assert.strictEqual(executionOrder[0], "operation1-start");
		assert.strictEqual(executionOrder[1], "operation2-start");
	});

	it("should release locks even if function throws", async () => {
		const error = new Error("test error");

		await assert.rejects(
			locks.withLock(testPath, () => {
				throw error;
			}),
			{ message: "test error" }
		);

		// Lock should be released, allowing another operation
		const result = await locks.withLock(
			testPath,
			() => "success-after-error"
		);
		assert.strictEqual(result, "success-after-error");
	});

	it("should release locks even if async function throws", async () => {
		const error = new Error("async test error");

		await assert.rejects(
			locks.withLock(testPath, async () => {
				await sleep(10);

				throw error;
			}),
			{ message: "async test error" }
		);

		// Lock should be released, allowing another operation
		const result = await locks.withLock(
			testPath,
			() => "success-after-async-error"
		);
		assert.strictEqual(result, "success-after-async-error");
	});

	it("should handle empty array of keys", async () => {
		const result = await locks.withLock([], () => "empty-keys");
		assert.strictEqual(result, "empty-keys");
	});

	it("should maintain FIFO order for multiple waiters", async () => {
		const executionOrder: string[] = [];

		// Start first operation that holds the lock
		const firstPromise = locks.withLock(testPath, async () => {
			executionOrder.push("first-start");
			await sleep(100);
			executionOrder.push("first-end");
			return "first";
		});

		// Small delay to ensure first operation starts
		await sleep(10);

		// Queue second and third operations
		const secondPromise = locks.withLock(testPath, async () => {
			executionOrder.push("second-start");
			await sleep(50);
			executionOrder.push("second-end");
			return "second";
		});

		const thirdPromise = locks.withLock(testPath, async () => {
			executionOrder.push("third-start");
			await sleep(20);
			executionOrder.push("third-end");
			return "third";
		});

		const [first, second, third] = await awaitAll([
			firstPromise,
			secondPromise,
			thirdPromise
		]);

		assert.strictEqual(first, "first");
		assert.strictEqual(second, "second");
		assert.strictEqual(third, "third");
		assert.deepStrictEqual(executionOrder, [
			"first-start",
			"first-end",
			"second-start",
			"second-end",
			"third-start",
			"third-end"
		]);
	});
});
