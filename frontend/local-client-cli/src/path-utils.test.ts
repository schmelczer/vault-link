import { test } from "node:test";
import * as assert from "node:assert/strict";
import { compileGlobPattern, toUnixPath } from "./path-utils";

function matches(path: string, pattern: string): boolean {
    return compileGlobPattern(pattern).test(path);
}

test("compileGlobPattern - exact match", () => {
    assert.equal(matches(".DS_Store", ".DS_Store"), true);
    assert.equal(matches("other", ".DS_Store"), false);
});

test("compileGlobPattern - dir/** matches directory and contents", () => {
    assert.equal(matches(".git", ".git/**"), true);
    assert.equal(matches(".git/config", ".git/**"), true);
    assert.equal(matches(".git/refs/heads/main", ".git/**"), true);
    assert.equal(matches(".gitignore", ".git/**"), false);
});

test("compileGlobPattern - * matches within a single segment", () => {
    assert.equal(matches("foo.tmp", "*.tmp"), true);
    assert.equal(matches("bar.tmp", "*.tmp"), true);
    assert.equal(matches("foo.md", "*.tmp"), false);
    // * does NOT cross path separators
    assert.equal(matches("dir/foo.tmp", "*.tmp"), false);
});

test("compileGlobPattern - **/*.ext matches at any depth", () => {
    assert.equal(matches("foo.tmp", "**/*.tmp"), true);
    assert.equal(matches("dir/foo.tmp", "**/*.tmp"), true);
    assert.equal(matches("a/b/c/foo.tmp", "**/*.tmp"), true);
    assert.equal(matches("foo.md", "**/*.tmp"), false);
});

test("compileGlobPattern - ? matches single character", () => {
    assert.equal(matches("a.md", "?.md"), true);
    assert.equal(matches("ab.md", "?.md"), false);
    assert.equal(matches(".md", "?.md"), false);
});

test("compileGlobPattern - dots are escaped", () => {
    assert.equal(matches(".DS_Store", ".DS_Store"), true);
    assert.equal(matches("xDS_Store", ".DS_Store"), false);
});

test("compileGlobPattern - node_modules/** matches directory tree", () => {
    assert.equal(matches("node_modules", "node_modules/**"), true);
    assert.equal(matches("node_modules/foo", "node_modules/**"), true);
    assert.equal(
        matches("node_modules/foo/bar/baz.js", "node_modules/**"),
        true
    );
    assert.equal(matches("not_node_modules", "node_modules/**"), false);
});

test("compileGlobPattern - **/ prefix matches zero or more segments", () => {
    assert.equal(matches("test.log", "**/test.log"), true);
    assert.equal(matches("dir/test.log", "**/test.log"), true);
    assert.equal(matches("a/b/test.log", "**/test.log"), true);
});

test("toUnixPath - forward slashes unchanged", () => {
    assert.equal(toUnixPath("foo/bar/baz"), "foo/bar/baz");
});
