import { describe, it } from "node:test";
import assert from "node:assert";
import { validateRelativePath } from "./validate-relative-path";

describe("validateRelativePath", () => {
    it("accepts normal relative paths", () => {
        assert.doesNotThrow(() => { validateRelativePath("file.md"); });
        assert.doesNotThrow(() => { validateRelativePath("folder/file.md"); });
        assert.doesNotThrow(
            () => { validateRelativePath("deeply/nested/folder/file.md"); }
        );
        assert.doesNotThrow(() => { validateRelativePath("file with spaces.md"); });
        assert.doesNotThrow(() => { validateRelativePath(".hidden-file"); });
        assert.doesNotThrow(() => { validateRelativePath("folder/.hidden"); });
    });

    it("accepts paths with single dots", () => {
        assert.doesNotThrow(() => { validateRelativePath("./file.md"); });
        assert.doesNotThrow(() => { validateRelativePath("folder/./file.md"); });
    });

    it("rejects empty paths", () => {
        assert.throws(() => { validateRelativePath(""); }, /must not be empty/);
    });

    it("rejects paths with .. components", () => {
        assert.throws(
            () => { validateRelativePath("../file.md"); },
            /must not contain '\.\.'/
        );
        assert.throws(
            () => { validateRelativePath("folder/../file.md"); },
            /must not contain '\.\.'/
        );
        assert.throws(
            () => { validateRelativePath("folder/../../etc/passwd"); },
            /must not contain '\.\.'/
        );
        assert.throws(
            () => { validateRelativePath(".."); },
            /must not contain '\.\.'/
        );
    });

    it("does not reject paths containing .. as part of a filename", () => {
        assert.doesNotThrow(
            () => { validateRelativePath("file..name.md"); }
        );
        assert.doesNotThrow(
            () => { validateRelativePath("folder/file..bak"); }
        );
    });

    it("rejects absolute paths starting with /", () => {
        assert.throws(
            () => { validateRelativePath("/etc/passwd"); },
            /must be relative/
        );
    });

    it("rejects absolute paths starting with \\", () => {
        assert.throws(
            () => { validateRelativePath("\\Windows\\System32"); },
            /must be relative/
        );
    });

    it("rejects paths containing backslashes", () => {
        assert.throws(
            () => { validateRelativePath("folder\\file.md"); },
            /must use forward slashes/
        );
    });

    it("rejects paths with null bytes", () => {
        assert.throws(
            () => { validateRelativePath("file\0.md"); },
            /null byte/
        );
    });
});
