import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, bytes } from "./sync-fixture";
import { toStoredSnapshot } from "../sync-client/src/sync-operations/content";
import { LocalChangesDuringReconciliation } from "../sync-client/src/errors/errors";

for (const equal of [false, true])
    test(`swaps preserve identities with ${equal ? "equal" : "distinct"} content and save once`, async () => {
        const f = await fixture({ "a.md": "A", "b.md": equal ? "A" : "B" });
        let saves = 0;
        f.persistence.boundary = (label) => {
            if (label === "before:save") saves++;
        };
        const next = structuredClone(f.database.state);
        next.local = { a: "b.md", b: "a.md" };
        await f.files.apply(next);
        assert.deepEqual(f.database.state.local, next.local);
        assert.deepEqual(
            f.disk.userFiles(),
            new Map([
                ["a.md", bytes(equal ? "A" : "B")],
                ["b.md", bytes("A")]
            ])
        );
        assert.equal(saves, 1);
        assert.deepEqual(await f.disk.listFilesRecursively(), ["a.md", "b.md"]);
    });

for (const direction of ["file-to-directory", "directory-to-file"])
    test(direction, async () => {
        const f = await fixture(
            direction === "file-to-directory"
                ? { folder: "A", "b.md": "B" }
                : { "a.md": "A", "folder/b.md": "B" }
        );
        const ids = Object.keys(f.database.state.local);
        const next = structuredClone(f.database.state);
        next.local =
            direction === "file-to-directory"
                ? { [ids[0]]: "folder/a.md", [ids[1]]: "b.md" }
                : { [ids[0]]: "folder", [ids[1]]: "other.md" };
        const expected = structuredClone(next.local);
        await f.files.apply(next);
        assert.deepEqual(f.database.state.local, expected);
        assert.deepEqual(
            new Set(f.disk.userFiles().keys()),
            new Set(Object.values(f.database.state.local))
        );
        assert.deepEqual(
            [...f.disk.userFiles().values()]
                .map((value) => Buffer.from(value).toString())
                .sort(),
            ["A", "B"]
        );
    });

test("an unexpected occupant is preserved under a visible conflict name", async () => {
    const f = await fixture();
    await f.disk.userWrite("remote.md", bytes("unexpected"));
    const next = structuredClone(f.database.state);
    next.local.a = "remote.md";
    await f.files.apply(next);
    assert.equal(f.database.state.local.a, "remote.md");
    assert.equal(f.disk.userFiles().size, 2);
    assert.deepEqual(
        [...f.disk.userFiles().values()]
            .map((value) => Buffer.from(value).toString())
            .sort(),
        ["local", "unexpected"]
    );
    assert.equal(Object.keys(f.database.state.local).length, 2);
});

test("content edited after planning is merged with the incoming snapshot", async () => {
    const f = await fixture({ "a.md": "base\n" });
    const expected = (await f.files.snapshot("a.md"))!;
    await f.disk.userWrite("a.md", bytes("base\nlocal\n"));
    await f.files.apply(structuredClone(f.database.state), {
        a: {
            expected,
            replacement: await toStoredSnapshot({
                content: bytes("remote\nbase\n")
            })
        }
    });
    assert.deepEqual(
        f.disk.userFiles().get("a.md"),
        bytes("remote\nbase\nlocal\n")
    );
});

test("deleting the source after planning does not resurrect it", async () => {
    const f = await fixture();
    const next = structuredClone(f.database.state);
    next.local.a = "remote.md";
    await f.disk.userDelete("a.md");
    await f.files.apply(next, {
        a: { replacement: await toStoredSnapshot({ content: bytes("remote") }) }
    });
    assert.deepEqual(f.disk.userFiles(), new Map());
    assert.deepEqual(f.database.state.local, {});
});

for (const protect of ["ignore", "size"] as const)
    test(`protect ${protect} at application time`, async () => {
        const f = await fixture();
        const next = structuredClone(f.database.state);
        next.local.a = "remote.md";
        if (protect === "ignore")
            await f.settings.setSetting("ignorePatterns", ["a.md"]);
        else await f.settings.setSetting("maxFileSizeMB", 0);
        await f.files.apply(next, {
            a: {
                replacement: await toStoredSnapshot({
                    content: bytes("remote")
                })
            }
        });
        assert.deepEqual(
            f.disk.userFiles(),
            new Map([["a.md", bytes("local")]])
        );
        assert.equal(f.database.state.local.a, "a.md");
        assert.equal(f.database.state.excluded?.a, "a.md");
    });

for (const when of ["planning", "installed"])
    test(`notified move during ${when} is attributed to the right identity on rescan`, async () => {
        const f = await fixture({ "a.md": "A", "b.md": "B" });
        let changed = false;
        f.disk.boundary = async (label) => {
            if (
                changed ||
                label !==
                    (when === "planning"
                        ? "read:stat:a.md"
                        : "visible:rename:a.md->b.md")
            )
                return;
            changed = true;
            const oldPath = when === "planning" ? "a.md" : "b.md";
            await f.disk.userRename(oldPath, "editor.md");
            await f.syncer.syncLocallyUpdatedFile({
                oldPath,
                relativePath: "editor.md"
            });
        };
        const next = structuredClone(f.database.state);
        next.local = { a: "b.md", b: "a.md" };
        if (when === "planning")
            await assert.rejects(
                f.files.apply(next),
                LocalChangesDuringReconciliation
            );
        else await f.files.apply(next);
        assert(changed);
        await f.internals.scan();
        assert.equal(f.database.state.local.a, "editor.md");
        assert.deepEqual(
            f.disk.userFiles().get(f.database.state.local.a),
            bytes("A")
        );
        assert.deepEqual(
            f.disk.userFiles().get(f.database.state.local.b),
            bytes("B")
        );
    });

for (const action of ["move", "delete"] as const)
    test(`notified ${action}/recreate between file operations does not repurpose the replacement file`, async () => {
        const f = await fixture({ "a.md": "A", "b.md": "B" });
        await f.settings.setSetting("ignorePatterns", ["private.md"]);
        let changed = false;
        f.disk.boundary = async (label) => {
            if (changed || label !== "visible:rename:a.md->remote-a.md") return;
            changed = true;
            if (action === "move") {
                await f.disk.userRename("b.md", "private.md");
                await f.syncer.syncLocallyUpdatedFile({
                    oldPath: "b.md",
                    relativePath: "private.md"
                });
            } else {
                await f.disk.userDelete("b.md");
                await f.syncer.syncLocallyDeletedFile("b.md");
            }
            await f.disk.userWrite("b.md", bytes("replacement"));
            await f.syncer.syncLocallyCreatedFile("b.md");
        };
        const next = structuredClone(f.database.state);
        next.local = { a: "remote-a.md", b: "remote-b.md" };
        await f.files.apply(next);
        assert(changed);
        await f.internals.scan();
        assert.deepEqual(f.disk.userFiles().get("b.md"), bytes("replacement"));
        assert.equal(f.disk.userFiles().has("remote-b.md"), false);
        assert.equal(
            f.database.state.local.b,
            action === "move" ? "private.md" : undefined
        );
        if (action === "move")
            assert.deepEqual(f.disk.userFiles().get("private.md"), bytes("B"));
    });

test("a file and nested directory exchange their exact paths", async () => {
    const f = await fixture({ a: "A", "b/deep/child": "B" });
    const [a, b] = Object.keys(f.database.state.local);
    const next = structuredClone(f.database.state);
    next.local = { [a]: "b", [b]: "a/deep/child" };
    await f.files.apply(next);
    assert.deepEqual(f.database.state.local, { [a]: "b", [b]: "a/deep/child" });
    assert.deepEqual(
        f.disk.userFiles(),
        new Map([
            ["b", bytes("A")],
            ["a/deep/child", bytes("B")]
        ])
    );
});
