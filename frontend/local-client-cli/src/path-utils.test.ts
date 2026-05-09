import { test } from "node:test";
import * as assert from "node:assert/strict";
import { matchesGlob, toUnixPath } from "./path-utils";

test("matchesGlob - exact match", () => {
    assert.equal(matchesGlob(".DS_Store", ".DS_Store"), true);
    assert.equal(matchesGlob("other", ".DS_Store"), false);
});

test("matchesGlob - dir/** matches directory and contents", () => {
    assert.equal(matchesGlob(".git", ".git/**"), true);
    assert.equal(matchesGlob(".git/config", ".git/**"), true);
    assert.equal(matchesGlob(".git/refs/heads/main", ".git/**"), true);
    assert.equal(matchesGlob(".gitignore", ".git/**"), false);
});

test("matchesGlob - * matches within a single segment", () => {
    assert.equal(matchesGlob("foo.tmp", "*.tmp"), true);
    assert.equal(matchesGlob("bar.tmp", "*.tmp"), true);
    assert.equal(matchesGlob("foo.md", "*.tmp"), false);
    assert.equal(matchesGlob("dir/foo.tmp", "*.tmp"), false);
});

test("matchesGlob - **/*.ext matches at any depth", () => {
    assert.equal(matchesGlob("foo.tmp", "**/*.tmp"), true);
    assert.equal(matchesGlob("dir/foo.tmp", "**/*.tmp"), true);
    assert.equal(matchesGlob("a/b/c/foo.tmp", "**/*.tmp"), true);
    assert.equal(matchesGlob("foo.md", "**/*.tmp"), false);
});

test("matchesGlob - ? matches single character", () => {
    assert.equal(matchesGlob("a.md", "?.md"), true);
    assert.equal(matchesGlob("ab.md", "?.md"), false);
    assert.equal(matchesGlob(".md", "?.md"), false);
});

test("matchesGlob - dots are literal", () => {
    assert.equal(matchesGlob(".DS_Store", ".DS_Store"), true);
    assert.equal(matchesGlob("xDS_Store", ".DS_Store"), false);
});

test("matchesGlob - node_modules/** matches directory tree", () => {
    assert.equal(matchesGlob("node_modules", "node_modules/**"), true);
    assert.equal(matchesGlob("node_modules/foo", "node_modules/**"), true);
    assert.equal(
        matchesGlob("node_modules/foo/bar/baz.js", "node_modules/**"),
        true
    );
    assert.equal(matchesGlob("not_node_modules", "node_modules/**"), false);
});

test("matchesGlob - **/ prefix matches zero or more segments", () => {
    assert.equal(matchesGlob("test.log", "**/test.log"), true);
    assert.equal(matchesGlob("dir/test.log", "**/test.log"), true);
    assert.equal(matchesGlob("a/b/test.log", "**/test.log"), true);
});

test("toUnixPath - forward slashes unchanged", () => {
    assert.equal(toUnixPath("foo/bar/baz"), "foo/bar/baz");
});
