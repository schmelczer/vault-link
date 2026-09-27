import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { allocatePortablePath, validatePortablePaths } from "./portable-path";

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

test("conflict allocation renames the first obstructed component deterministically", () => {
    const cases: { wanted: string; occupied: string[]; expected: string }[] = [
        {
            wanted: "Notes/a.md",
            occupied: ["Notes/b.md"],
            expected: "Notes/a.md"
        },
        {
            wanted: "Notes/a.md",
            occupied: ["notes/b.md"],
            expected: "Notes (conflict new)/a.md"
        },
        {
            wanted: "Notes/a.md",
            occupied: ["Notes"],
            expected: "Notes (conflict new)/a.md"
        },
        {
            wanted: "Notes",
            occupied: ["Notes/a.md"],
            expected: "Notes (conflict new)"
        },
        {
            wanted: "note.md",
            occupied: ["note.md", "note (conflict new).md"],
            expected: "note (conflict new) (1).md"
        },
        {
            wanted: "Straße/a.md",
            occupied: ["STRASSE/b.md"],
            expected: "Straße (conflict new)/a.md"
        }
    ];
    for (const { wanted, occupied, expected } of cases) {
        const actual = allocatePortablePath(wanted, "new", occupied);
        assert.equal(actual, expected);
        assert.equal(
            allocatePortablePath(wanted, "new", occupied.toReversed()),
            actual
        );
        validatePortablePaths([...occupied, actual]);
    }
});

test("shared directories remain distinct from aliases and file ancestors", () => {
    validatePortablePaths(["Notes/one.md", "Notes/two.md", "Other/one.md"]);
    for (const paths of [
        ["Notes/one.md", "notes/two.md"],
        ["Straße/one.md", "STRASSE/two.md"],
        ["Notes", "Notes/one.md"],
        ["Notes/one.md", "Notes"],
        ["Notes/one.md", "Notes/one.md"]
    ]) {
        assert.throws(() => {
            validatePortablePaths(paths);
        }, /Conflicting path/);
    }
});
