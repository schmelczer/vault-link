import { describe, it } from "node:test";
import assert from "node:assert";
import { isFileTypeMergeable } from "./is-file-type-mergeable";

const mergeableExtensions = ["md", "txt"];
describe("isFileTypeMergeable", () => {
    it("should return true for .md files", () => {
        assert.strictEqual(isFileTypeMergeable(".md", mergeableExtensions), true);
        assert.strictEqual(
            isFileTypeMergeable("hi.md", mergeableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergeable("my/path/to/my/document.md", mergeableExtensions),
            true
        );
    });

    it("should return true for .txt files", () => {
        assert.strictEqual(
            isFileTypeMergeable(".txt", mergeableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergeable("hi.txt", mergeableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergeable(
                "my/path/to/my/document.txt",
                mergeableExtensions
            ),
            true
        );
    });

    it("should be case insensitive", () => {
        assert.strictEqual(
            isFileTypeMergeable("hi.MD", mergeableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergeable("my/path/to/my/DOCUMENT.MD", mergeableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergeable("hi.TXT", mergeableExtensions),
            true
        );
        assert.strictEqual(
            isFileTypeMergeable(
                "my/path/to/my/DOCUMENT.TXT",
                mergeableExtensions
            ),
            true
        );
    });

    it("should return false for non-mergeable file types", () => {
        assert.strictEqual(
            isFileTypeMergeable(".json", mergeableExtensions),
            false
        );
        assert.strictEqual(
            isFileTypeMergeable("HELLO.JSON", mergeableExtensions),
            false
        );
        assert.strictEqual(
            isFileTypeMergeable("my/config.yml", mergeableExtensions),
            false
        );
    });
});

for (const path of [
    "md",
    "txt",
    "nested/md",
    "nested/txt",
    "a.md/txt",
    "a.txt/md",
    "note."
]) {
    it(`does not merge an extensionless file: ${path}`, () => {
        assert.equal(isFileTypeMergeable(path, ["md", "txt"]), false);
    });
}
