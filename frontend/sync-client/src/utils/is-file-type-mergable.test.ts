import { describe, it } from "node:test";
import assert from "node:assert";
import { isFileTypeMergable } from "./is-file-type-mergable";

describe("isFileTypeMergable", () => {
	it("should return true for .md files", () => {
		assert.strictEqual(isFileTypeMergable(".md"), true);
		assert.strictEqual(isFileTypeMergable("hi.md"), true);
		assert.strictEqual(
			isFileTypeMergable("my/path/to/my/document.md"),
			true
		);
	});

	it("should return true for .txt files", () => {
		assert.strictEqual(isFileTypeMergable(".txt"), true);
		assert.strictEqual(isFileTypeMergable("hi.txt"), true);
		assert.strictEqual(
			isFileTypeMergable("my/path/to/my/document.txt"),
			true
		);
	});

	it("should be case insensitive", () => {
		assert.strictEqual(isFileTypeMergable("hi.MD"), true);
		assert.strictEqual(
			isFileTypeMergable("my/path/to/my/DOCUMENT.MD"),
			true
		);
		assert.strictEqual(isFileTypeMergable("hi.TXT"), true);
		assert.strictEqual(
			isFileTypeMergable("my/path/to/my/DOCUMENT.TXT"),
			true
		);
	});

	it("should return false for non-mergable file types", () => {
		assert.strictEqual(isFileTypeMergable(".json"), false);
		assert.strictEqual(isFileTypeMergable("HELLO.JSON"), false);
		assert.strictEqual(isFileTypeMergable("my/config.yml"), false);
	});
});
