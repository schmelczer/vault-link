import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
    allocatePortablePath,
    validatePortablePaths,
    arePathAliases,
    findPathWithSameSpelling,
    isInternalPath
} from "./portable-path";

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

for (const [left, right, aliases] of [
    ["café.md", "cafe\u0301.md", true],
    ["Notes/File.md", "notes/file.MD", true],
    ["Straße.md", "STRASSE.md", true],
    ["σ.md", "ς.md", true],
    ["İ.md", "i.md", false],
    ["a.md", "b.md", false]
] as const) {
    test(`portable alias comparison: ${left} / ${right}`, () => {
        assert.equal(arePathAliases(left, right), aliases);
        assert.equal(arePathAliases(right, left), aliases);
    });
}

test("same spelling preserves Unicode aliases without hiding case-only renames", () => {
    assert.equal(
        findPathWithSameSpelling(["café.md"], "cafe\u0301.md"),
        "café.md"
    );
    assert.equal(findPathWithSameSpelling(["note.md"], "Note.md"), undefined);
    assert.equal(
        findPathWithSameSpelling(["Straße.md"], "STRASSE.md"),
        undefined
    );
    assert.equal(findPathWithSameSpelling(["note.md"], "note.md"), undefined);
});

test("only the top-level internal directory is reserved, including aliases", () => {
    for (const path of [".vault-link-sync", ".VAULT-LINK-SYNC/state.json"]) {
        assert.equal(isInternalPath(path), true);
        assert.throws(() => {
            validatePortablePaths([path]);
        }, /Invalid portable path/u);
        const allocated = allocatePortablePath(path, "id", []);
        assert.equal(allocated, "_" + path);
        validatePortablePaths([allocated]);
    }

    for (const path of [
        "notes/.vault-link-sync/a.md",
        ".vault-link-sync-other/a.md"
    ]) {
        assert.equal(isInternalPath(path), false);
        validatePortablePaths([path]);
    }
});

test("invalid components and device names are sanitized in every directory", () => {
    const cases = [
        ["", "_"],
        [".", "_"],
        ["..", "_"],
        ["a//b.md", "a/_/b.md"],
        ["/a.md", "_/a.md"],
        ["a/../b.md", "a/_/b.md"],
        ["cafe\u0301.md", "café.md"],
        ['bad<>:"\\|?*\u0000.md', "bad_________.md"],
        ["trailing. ", "trailing_"],
        ["CON.txt", "_CON.txt"],
        ["aux .md", "_aux .md"],
        ["LPT¹.txt", "_LPT¹.txt"],
        ["com²/PRN.md", "_com²/_PRN.md"],
        ["CONIN$", "_CONIN$"],
        ["conout$.txt", "_conout$.txt"]
    ];
    for (const [wanted, expected] of cases) {
        assert.ok(wanted !== undefined && expected !== undefined);
        assert.throws(() => {
            validatePortablePaths([wanted]);
        }, /Invalid portable path/u);
        assert.equal(allocatePortablePath(wanted, "id", []), expected);
        validatePortablePaths([expected]);
    }

    validatePortablePaths(["COM0.txt", "LPT10.md", "console.md", ".hidden"]);
});

test("long UTF-8 components preserve the entire conflict suffix and extension", () => {
    for (const character of ["a", "é", "界", "🦊"]) {
        const wanted = `${character.repeat(260)}.md`;
        const allocated = allocatePortablePath(wanted, "identity", []);
        assert.ok(allocated.endsWith(" (conflict identity).md"));
        assert.ok(new TextEncoder().encode(allocated).length <= 255);
        assert.ok(allocated.isWellFormed());
        assert.equal(allocated, allocated.normalize("NFC"));
        validatePortablePaths([allocated]);
        assert.equal(
            allocatePortablePath(allocated, "identity", []),
            allocated
        );
    }
});

test("byte limits apply to IDs, extensions and directories independently", () => {
    const allocated = allocatePortablePath(
        `${"d".repeat(256)}/${"🦊".repeat(80)}.${"é".repeat(80)}`,
        "界".repeat(100),
        []
    );
    const [directory, file] = allocated.split("/");
    assert.equal(directory, `${"d".repeat(180)} (conflict ${"界".repeat(21)})`);
    assert.ok(file !== undefined);
    assert.ok(
        file.endsWith(` (conflict ${"界".repeat(21)}).${"é".repeat(31)}`)
    );
    for (const part of allocated.split("/")) {
        assert.ok(new TextEncoder().encode(part).length <= 255);
        assert.ok(part.isWellFormed());
    }

    validatePortablePaths([allocated]);
});

test("repeated long-name collisions keep a unique suffix without losing the extension", () => {
    const wanted = `${"🦊".repeat(70)}.md`;
    const occupied: string[] = [];
    for (let i = 0; i < 12; i++) {
        const path = allocatePortablePath(wanted, "same-id", occupied);
        assert.equal(occupied.includes(path), false);
        assert.equal(
            allocatePortablePath(wanted, "same-id", occupied.toReversed()),
            path
        );
        assert.ok(path.endsWith(".md"));
        assert.ok(new TextEncoder().encode(path).length <= 255);
        occupied.push(path);
        validatePortablePaths(occupied);
    }
});

test("allocation resolves both ancestor and leaf collisions without changing siblings", () => {
    const occupied = ["notes/other.md", "Notes (conflict id)/FILE.md"];
    const path = allocatePortablePath("Notes/file.md", "id", occupied);
    assert.equal(path, "Notes (conflict id)/file (conflict id) (1).md");
    validatePortablePaths([...occupied, path]);
    assert.equal(
        allocatePortablePath("notebook.md", "id", ["note"]),
        "notebook.md"
    );
    assert.equal(
        allocatePortablePath(".hidden", "id", [".hidden"]),
        ".hidden (conflict id)"
    );
});

test("manifest conflicts throw TypeError", () => {
    assert.throws(
        () => {
            validatePortablePaths(["a.md", "A.md"]);
        },
        {
            name: "TypeError",
            message: "Conflicting path: A.md"
        }
    );
});
