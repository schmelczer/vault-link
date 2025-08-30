import { describe, test } from "node:test";
import assert from "node:assert";
import { positionToLineAndColumn } from "./position-to-line-and-column";

describe("positionToLineAndColumn", () => {
	test("converts position to line and column in multi-line text", () => {
		const text = "ab\ncd\n";
		assert.deepStrictEqual(positionToLineAndColumn(text, 0), {
			line: 0,
			column: 0
		});
		assert.deepStrictEqual(positionToLineAndColumn(text, 1), {
			line: 0,
			column: 1
		});
		assert.deepStrictEqual(positionToLineAndColumn(text, 2), {
			line: 0,
			column: 2
		});
		assert.deepStrictEqual(positionToLineAndColumn(text, 3), {
			line: 1,
			column: 0
		});
		assert.deepStrictEqual(positionToLineAndColumn(text, 4), {
			line: 1,
			column: 1
		});
		assert.deepStrictEqual(positionToLineAndColumn(text, 6), {
			line: 2,
			column: 0
		});
	});

	test("with carrige returns", () => {
		assert.deepStrictEqual(positionToLineAndColumn("a\nb", 3), {
			line: 1,
			column: 1
		});

		assert.deepStrictEqual(positionToLineAndColumn("a\r\nb", 3), {
			line: 1,
			column: 1
		});
	});

	test("handles empty input", () => {
		assert.deepStrictEqual(positionToLineAndColumn("", 0), {
			line: 0,
			column: 0
		});
	});

	test("handles positions at the end of text", () => {
		const text = "End";
		assert.deepStrictEqual(positionToLineAndColumn(text, 3), {
			line: 0,
			column: 3
		});
	});

	test("throws error for position out of range", () => {
		const text = "Short text";
		assert.throws(() => positionToLineAndColumn(text, 15));
		assert.throws(() => positionToLineAndColumn(text, -1));
	});
});
