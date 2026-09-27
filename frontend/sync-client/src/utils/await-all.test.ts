import { test } from "node:test";
import assert from "node:assert";
import { awaitAll } from "./await-all";

void test("awaitAll resolves promises of the same type", async () => {
    const promises = [
        Promise.resolve(1),
        Promise.resolve(2),
        Promise.resolve(3)
    ];

    const results = await awaitAll(promises);
    assert.deepStrictEqual(results, [1, 2, 3]);
});

void test("awaitAll resolves promises of different types", async () => {
    const promises = [
        Promise.resolve("hello"),
        Promise.resolve(42),
        Promise.resolve(true)
    ] as const;

    const results = await awaitAll(promises);

    // Type assertions to verify type inference
    const str: string = results[0];
    const num: number = results[1];
    const bool: boolean = results[2];

    assert.strictEqual(str, "hello");
    assert.strictEqual(num, 42);
    assert.strictEqual(bool, true);
});

void test("awaitAll throws on first rejection", async () => {
    const error = new Error("Test error");
    const promises = [
        Promise.resolve(1),
        Promise.reject(error),
        Promise.resolve(3)
    ];

    await assert.rejects(async () => {
        await awaitAll(promises);
    }, error);
});

void test("awaitAll works with async functions", async () => {
    const asyncString = async (): Promise<string> => "async";
    const asyncNumber = async (): Promise<number> => 123;

    const results = await awaitAll([asyncString(), asyncNumber()]);

    assert.strictEqual(results[0], "async");
    assert.strictEqual(results[1], 123);
});

void test("awaitAll drains unfinished work before reporting a rejection", async () => {
    const pending = Promise.withResolvers<undefined>();
    const error = new Error("failed first");
    let finished = false;
    const checked = assert
        .rejects(awaitAll([Promise.reject(error), pending.promise]), error)
        .then(() => {
            finished = true;
        });
    try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(finished, false);
    } finally {
        pending.resolve(undefined);
    }

    await checked;
});
