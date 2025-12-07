import { describe, it } from "node:test";
import assert from "node:assert";
import { isFileTypeMergable } from "./is-file-type-mergable";

const mergableExtensions = ["md", "txt"];
describe("isFileTypeMergable", () => {
    it("should return true for .md files", () => {
        assert.strictEqual(isFileTypeMergable(".md", mergableExtensions), true);
        assert.strictEqual(
            isFileTypeMergable("hi.md", mergableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergable("my/path/to/my/document.md", mergableExtensions),
            true
        );
    });

    it("should return true for .txt files", () => {
        assert.strictEqual(
            isFileTypeMergable(".txt", mergableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergable("hi.txt", mergableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergable(
                "my/path/to/my/document.txt",
                mergableExtensions
            ),
            true
        );
    });

    it("should be case insensitive", () => {
        assert.strictEqual(
            isFileTypeMergable("hi.MD", mergableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergable("my/path/to/my/DOCUMENT.MD", mergableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergable("hi.TXT", mergableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergable(
                "my/path/to/my/DOCUMENT.TXT",
                mergableExtensions
            ),
            true
        );
    });

    it("should return false for non-mergable file types", () => {
        assert.strictEqual(
            isFileTypeMergable(".json", mergableExtensions),
            false
        );
        assert.strictEqual(
            isFileTypeMergable("HELLO.JSON", mergableExtensions),
            false
        );
        assert.strictEqual(
            isFileTypeMergable("my/config.yml", mergableExtensions),
            false
        );
    });
});
