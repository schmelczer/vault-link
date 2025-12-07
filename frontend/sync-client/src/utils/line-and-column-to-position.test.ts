import { describe, it } from "node:test";
import assert from "node:assert";
import { lineAndColumnToPosition } from "./line-and-column-to-position";

describe("lineAndColumnToPosition", () => {
    it("should return the correct position for the first line", () => {
        const text = "Hello\nWorld";
        const position = lineAndColumnToPosition(text, 0, 3);
        assert.strictEqual(position, 3);
    });

    it("should return the correct position for the second line", () => {
        const text = "Hello\nWorld";
        const position = lineAndColumnToPosition(text, 1, 2);
        assert.strictEqual(position, 8);
    });

    it("should return the correct position for an empty string", () => {
        const text = "";
        const position = lineAndColumnToPosition(text, 0, 0);
        assert.strictEqual(position, 0);
    });

    it("with carrige return", () => {
        assert.strictEqual(lineAndColumnToPosition("a\nb", 1, 1), 3);
        assert.strictEqual(lineAndColumnToPosition("a\r\nb", 1, 1), 3);
    });

    it("should handle multi-line strings with varying lengths", () => {
        const text = "Line1\nLongerLine2\nShort3";
        const position = lineAndColumnToPosition(text, 2, 4);
        assert.strictEqual(position, 22);
    });

    it("should throw an error if the line number is out of range", () => {
        const text = "Line1\nLine2";
        assert.throws(() => lineAndColumnToPosition(text, 3, 0));
    });

    it("should throw an error if the column number is out of range", () => {
        const text = "Line1\nLine2";
        assert.throws(() => lineAndColumnToPosition(text, 1, 10));
    });
});
