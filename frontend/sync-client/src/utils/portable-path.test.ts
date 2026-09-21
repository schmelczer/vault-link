import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { validatePortablePaths } from "./portable-path";

test("a small deeply nested manifest fits within a bounded validation heap", () => {
    const source = pathToFileURL(resolve(__dirname, "portable-path.ts")).href;
    const result = spawnSync(
        process.execPath,
        [
            "--max-old-space-size=64",
            "--import",
            require.resolve("tsx"),
            "--input-type=module",
            "--eval",
            `
            import { validatePortablePaths } from ${JSON.stringify(source)};
            const directory = Array(20000).fill("a").join("/");
            validatePortablePaths([directory + "/one.md", directory + "/two.md"]);
        `
        ],
        { encoding: "utf8", timeout: 10000 }
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
});

test("shared directories remain distinct from aliases and file ancestors", () => {
    validatePortablePaths(["Notes/one.md", "Notes/two.md", "Other/one.md"]);
    for (const paths of [
        ["Notes/one.md", "notes/two.md"],
        ["Straße/one.md", "STRASSE/two.md"],
        ["Notes", "Notes/one.md"],
        ["Notes/one.md", "Notes"],
        ["Notes/one.md", "Notes/one.md"]
    ])
        assert.throws(() => validatePortablePaths(paths), /Conflicting path/);
});
