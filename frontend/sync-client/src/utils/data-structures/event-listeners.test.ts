import { describe, it } from "node:test";
import assert from "node:assert";
import { EventListeners } from "./event-listeners";

describe("EventListeners", () => {
    it("should add & remove listeners", () => {
        const listeners = new EventListeners<() => void>();
        const listener = () => { };

        listeners.add(listener);

        assert.strictEqual(listeners.count, 1);

        const removed = listeners.remove(listener);
        assert.strictEqual(removed, true);
        assert.strictEqual(listeners.count, 0);
    });


    it("should remove listeners using unsubscribe function", () => {
        const listeners = new EventListeners<() => void>();
        const listener = () => { };

        const unsubscribe = listeners.add(listener);
        unsubscribe();

        assert.strictEqual(listeners.count, 0);
    });

    it("should return false when removing non-existent listener", () => {
        const listeners = new EventListeners<() => void>();
        const listener = () => { };

        const removed = listeners.remove(listener);

        assert.strictEqual(removed, false);
    });

    it("should handle multiple listeners", () => {
        const listeners = new EventListeners<() => void>();
        const listener1 = () => { };
        const listener2 = () => { };
        const listener3 = () => { };

        listeners.add(listener1);
        listeners.add(listener2);
        listeners.add(listener3);

        assert.strictEqual(listeners.count, 3);

        listeners.remove(listener2);

        assert.strictEqual(listeners.count, 2);
    });

    it("should trigger all listeners synchronously", () => {
        const listeners = new EventListeners<(value: string) => void>();
        const calls: string[] = [];

        listeners.add((value) => calls.push(`listener1-${value}`));
        listeners.add((value) => calls.push(`listener2-${value}`));

        listeners.trigger("test");

        assert.deepStrictEqual(calls, ["listener1-test", "listener2-test"]);
    });

    it("should trigger listeners with multiple arguments", () => {
        const listeners = new EventListeners<
            (a: number, b: string, c: boolean) => void
        >();
        const calls: [number, string, boolean][] = [];

        listeners.add((a, b, c) => calls.push([a, b, c]));
        listeners.trigger(42, "hello", true);

        assert.deepStrictEqual(calls, [[42, "hello", true]]);
    });

    it("should not trigger removed listeners", () => {
        const listeners = new EventListeners<() => void>();
        let count1 = 0;
        let count2 = 0;

        const listener1 = () => {
            count1++;
        };
        const listener2 = () => {
            count2++;
        };

        listeners.add(listener1);
        const unsubscribe = listeners.add(listener2);

        unsubscribe();
        listeners.trigger();

        assert.strictEqual(count1, 1);
        assert.strictEqual(count2, 0);
    });

    it("should trigger all listeners and await promises", async () => {
        const listeners = new EventListeners<
            (value: string) => Promise<void> | void
        >();
        const results: string[] = [];

        listeners.add(async (value) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            results.push(`async1-${value}`);
        });

        listeners.add((value) => {
            results.push(`sync-${value}`);
        });

        listeners.add(async (value) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            results.push(`async2-${value}`);
        });

        await listeners.triggerAsync("test");

        assert.ok(results.includes("async1-test"));
        assert.ok(results.includes("sync-test"));
        assert.ok(results.includes("async2-test"));
        assert.strictEqual(results.length, 3);
    });



    it("should not trigger cleared listeners", () => {
        const listeners = new EventListeners<() => void>();
        let called = false;
        const listener = () => {
            called = true;
        };

        listeners.add(listener);
        listeners.clear();

        assert.strictEqual(listeners.count, 0);
        listeners.trigger();

        assert.strictEqual(called, false);
    });
});
