import { describe, it } from "node:test";
import assert from "node:assert";
import { randomCasing } from "./random-casing";

describe("randomCasing", () => {
    it("simple test", () => {
        const input =
            "hello, this is a really long string with a lot of characters";
        const result = randomCasing(input, () => 0);
        assert.strictEqual(result.toLowerCase(), input.toLowerCase());
        assert.notStrictEqual(result, input);
    });
});
