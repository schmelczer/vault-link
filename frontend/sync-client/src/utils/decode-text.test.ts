import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeText } from "./decode-text";
import { isBinary } from "./is-binary";

test("text decoding preserves BOMs and line endings across successive files", () => {
    for (const text of ["\uFEFFfirst\r\n", "plain\n", "\uFEFFé🙂\r\n"]) {
        const bytes = new TextEncoder().encode(text);
        assert.equal(isBinary(bytes), false);
        assert.equal(decodeText(bytes), text);
    }
});

test("invalid UTF-8 is binary and does not affect subsequent text decoding", () => {
    const invalid = new Uint8Array([0xc3]);
    assert.equal(isBinary(invalid), true);
    assert.throws(() => decodeText(invalid));
    assert.equal(decodeText(new TextEncoder().encode("valid")), "valid");
    assert.equal(isBinary(new Uint8Array([0])), true);
});
