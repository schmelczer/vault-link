import assert from "node:assert/strict";
import { test } from "node:test";
import { Lock } from "./locks";

test("queued operations run in order and retain their results", async () => {
    const lock = new Lock();
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const calls: number[] = [];
    const first = lock.withLock(async () => {
        calls.push(1);
        started.resolve();
        await held.promise;
        calls.push(2);
        return "first";
    });
    const second = lock.withLock(() => {
        calls.push(3);
        return "second";
    });
    const third = lock.withLock(() => {
        calls.push(4);
        return "third";
    });
    await started.promise;
    assert.deepEqual(calls, [1]);
    held.resolve();
    assert.equal(await first, "first");
    assert.equal(await second, "second");
    assert.equal(await third, "third");
    assert.deepEqual(calls, [1, 2, 3, 4]);
});

for (const asynchronous of [false, true]) {
    test(`a ${asynchronous ? "rejected promise" : "thrown error"} releases the lock`, async () => {
        const lock = new Lock();
        const error = new Error("failed operation");
        const failed = lock.withLock(() => {
            if (asynchronous) return Promise.reject(error);
            throw error;
        });
        const next = lock.withLock(() => "continued");
        await assert.rejects(failed, (caught) => caught === error);
        assert.equal(await next, "continued");
    });
}
