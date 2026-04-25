import { describe, it } from "node:test";
import assert from "node:assert";
import { buildConflictFileName, CONFLICT_PATH_REGEX } from "./conflict-path";

describe("buildConflictFileName", () => {
    it("truncates to the filesystem byte limit while preserving the extension", () => {
        const result = buildConflictFileName(`${"a".repeat(300)}.md`);
        assert.ok(Buffer.byteLength(result, "utf8") <= 255);
        assert.ok(result.endsWith(".md"));
    });

    it("truncates on a codepoint boundary for multi-byte UTF-8 names", () => {
        // "🎉" is 4 bytes in UTF-8; splitting one would yield U+FFFD.
        const result = buildConflictFileName(`${"🎉".repeat(100)}.md`);
        assert.ok(Buffer.byteLength(result, "utf8") <= 255);
        assert.ok(!result.includes("�"));
    });

    it("does not split a ZWJ emoji sequence", () => {
        // 👨‍👩‍👧 is one grapheme but 5 code points joined by U+200D.
        // A codepoint-only truncation can leave a dangling ZWJ.
        const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
        const result = buildConflictFileName(`${family.repeat(20)}.md`);
        assert.ok(Buffer.byteLength(result, "utf8") <= 255);
        const stem = result.slice(
            "conflict-".length + 36 + 1,
            result.length - ".md".length
        );
        assert.strictEqual(
            stem.length % family.length,
            0,
            "stem length must be a whole number of families"
        );
        assert.ok(!stem.endsWith("‍"), "stem must not end with a dangling ZWJ");
    });

    it("does not split a base character from its combining mark", () => {
        // NFD "é" = "e" (U+0065) + combining acute (U+0301): one grapheme,
        // two code points. A codepoint-only loop can strand the accent.
        const grapheme = "é";
        const result = buildConflictFileName(`${grapheme.repeat(150)}.md`);
        assert.ok(Buffer.byteLength(result, "utf8") <= 255);
        const stem = result.slice(
            "conflict-".length + 36 + 1,
            result.length - ".md".length
        );
        assert.strictEqual(
            stem.length % grapheme.length,
            0,
            "stem length must be a whole number of graphemes"
        );
        assert.ok(
            !stem.endsWith("́") || stem.endsWith(grapheme),
            "combining mark must stay attached to its base character"
        );
    });
});

describe("CONFLICT_PATH_REGEX", () => {
    it("does not misclassify user-authored names that start with `conflict-`", () => {
        assert.strictEqual(
            CONFLICT_PATH_REGEX.test("conflict-resolution.md"),
            false
        );
    });

    it("only inspects the final path segment", () => {
        assert.strictEqual(
            CONFLICT_PATH_REGEX.test(
                "conflict-12345678-1234-1234-1234-123456789abc-x/note.md"
            ),
            false
        );
        assert.strictEqual(
            CONFLICT_PATH_REGEX.test(
                "a/b/conflict-12345678-1234-1234-1234-123456789abc-note.md"
            ),
            true
        );
    });

    it("round-trips with buildConflictFileName", () => {
        assert.strictEqual(
            CONFLICT_PATH_REGEX.test(buildConflictFileName("note.md")),
            true
        );
    });
});
