import assert from "node:assert";
import { test } from "node:test";
import { EMPTY_HASH, hash } from "./hash";

void test("EMPTY_HASH is the SHA-256 hash of empty content", async () => {
    assert.strictEqual(await hash(new Uint8Array()), EMPTY_HASH);
});
