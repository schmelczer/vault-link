import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, bytes, head } from "./sync-fixture";
import { toStoredSnapshot } from "../sync-client/src/sync-operations/content";

for (const origin of ["bootstrap", "history recovery"])
    test(`cancelling a replacement retains the ${origin} merge context`, async () => {
        const f = await fixture(
            { "a.md": "BASE\n" },
            { getDocumentVersionContent: async () => bytes("REMOTE\nBASE\n") }
        );
        const recoveryBase = await toStoredSnapshot({
            content: bytes("BASE\n")
        });
        if (origin === "bootstrap")
            f.database.state.documents.a.bootstrap = true;
        else f.database.state.documents.a.recoveryBase = recoveryBase;
        await f.database.save();
        await f.settings.setSetting("ignorePatterns", ["private.md"]);
        let injected = false;
        f.disk.boundary = async (label) => {
            if (
                injected ||
                !label.startsWith("before:mkdir:.vault-link-sync/transactions/")
            )
                return;
            injected = true;
            await f.disk.userRename("a.md", "private.md");
            await f.disk.userWrite("private.md", bytes("BASE\nLOCAL\n"));
            await f.syncer.syncLocallyUpdatedFile({
                oldPath: "a.md",
                relativePath: "private.md"
            });
        };
        await f.internals.incorporateContent(head("a", 2, "REMOTE\nBASE\n"));
        assert(injected);
        const deferred = f.database.state.documents.a;
        assert.equal(deferred.base, undefined);
        if (origin === "bootstrap") assert.equal(deferred.bootstrap, true);
        else assert.deepEqual(deferred.recoveryBase, recoveryBase);
        f.disk.boundary = () => {};
        await f.settings.setSetting("ignorePatterns", []);
        await f.internals.incorporateFileManifest(
            f.database.state.fileManifest
        );
        const content = Buffer.from(
            f.disk.userFiles().get("private.md")!
        ).toString();
        assert.equal(content.match(/REMOTE/g)?.length, 1);
        assert.equal(content.match(/LOCAL/g)?.length, 1);
        assert.equal(f.database.state.documents.a.base?.vaultUpdateId, 2);
        assert.equal(f.database.state.documents.a.recoveryBase, undefined);
    });

for (const timing of ["before", "durable"])
    test(`a save that exceeds the size limit ${timing} staging keeps its exact bytes`, async () => {
        const f = await fixture({ "a.bin": "PUBLIC" });
        await f.settings.setSetting("maxFileSizeMB", 100 / (1024 * 1024));
        const large = "PRIVATE".repeat(100);
        let injected = false;
        f.disk.boundary = async (label) => {
            if (
                injected ||
                !label.startsWith(
                    `${timing}:rename:a.bin->.vault-link-sync/transactions/`
                )
            )
                return;
            injected = true;
            await f.disk.userWrite("a.bin", bytes(large));
            await f.syncer.syncLocallyUpdatedFile({ relativePath: "a.bin" });
        };
        await f.files.apply(structuredClone(f.database.state), {
            a: {
                expected: await toStoredSnapshot({ content: bytes("PUBLIC") }),
                replacement: await toStoredSnapshot({
                    content: bytes("REMOTE")
                })
            }
        });
        assert(injected);
        assert.equal(
            Buffer.from(f.disk.userFiles().get("a.bin")!).toString(),
            large
        );
        assert.equal(f.database.state.excluded?.a, "a.bin");
        assert.deepEqual(f.database.state.local, { a: "a.bin" });
    });

test("an excluded move after installation survives an uncertain journal acknowledgement", async () => {
    const f = await fixture({ "a.md": "PUBLIC" });
    await f.settings.setSetting("ignorePatterns", ["private.md"]);
    let moved = false,
        crashed = false;
    f.disk.boundary = async (label) => {
        if (
            moved ||
            !label.startsWith("durable:rename:") ||
            !label.endsWith(".output->a.md")
        )
            return;
        moved = true;
        await f.disk.userRename("a.md", "private.md");
        await f.disk.userWrite("private.md", bytes("SECRET"));
        await f.syncer.syncLocallyUpdatedFile({
            oldPath: "a.md",
            relativePath: "private.md"
        });
    };
    f.persistence.boundary = (label) => {
        if (!moved || crashed || label !== "durable:save") return;
        crashed = true;
        throw new Error("lost journal acknowledgement");
    };
    await assert.rejects(
        f.files.apply(structuredClone(f.database.state), {
            a: {
                expected: await toStoredSnapshot({ content: bytes("PUBLIC") }),
                replacement: await toStoredSnapshot({
                    content: bytes("PUBLIC REMOTE")
                })
            }
        }),
        /lost journal acknowledgement/
    );
    assert(moved && crashed);
    f.disk.boundary = () => {};
    f.persistence.boundary = () => {};
    await f.database.recoverPersistence();
    await f.files.recover();
    assert.deepEqual(f.database.state.local, { a: "private.md" });
    assert.equal(
        Buffer.from(f.disk.userFiles().get("private.md")!).toString(),
        "SECRET"
    );
});

test("moving a tracked file into an ignored path during a journal leaves it protected", async () => {
    const f = await fixture({ "a.md": "PUBLIC", "b.md": "OTHER" });
    await f.settings.setSetting("ignorePatterns", ["private.md"]);
    const next = structuredClone(f.database.state);
    next.local.b = "remote-b.md";
    let injected = false;
    f.disk.boundary = async (label) => {
        if (
            injected ||
            !label.startsWith("before:mkdir:.vault-link-sync/transactions/")
        )
            return;
        injected = true;
        await f.disk.userRename("a.md", "private.md");
        await f.disk.userWrite("private.md", bytes("SECRET"));
        await f.syncer.syncLocallyUpdatedFile({
            oldPath: "a.md",
            relativePath: "private.md"
        });
    };
    await f.files.apply(next);
    assert(injected);
    assert.equal(
        Buffer.from(f.disk.userFiles().get("private.md") ?? []).toString(),
        "SECRET"
    );
    assert.equal(f.database.state.local.a, "private.md");
    assert.equal(f.database.state.excluded?.a, "a.md");
});

test("a directory move protects each ignored descendant during a journal", async () => {
    const f = await fixture({ "folder/a.md": "PUBLIC", "b.md": "OTHER" });
    await f.settings.setSetting("ignorePatterns", ["private/**"]);
    const next = structuredClone(f.database.state);
    next.local.b = "remote-b.md";
    let injected = false;
    f.disk.boundary = async (label) => {
        if (
            injected ||
            !label.startsWith("before:mkdir:.vault-link-sync/transactions/")
        )
            return;
        injected = true;
        await f.disk.userRename("folder/a.md", "private/a.md");
        await f.disk.userWrite("private/a.md", bytes("SECRET"));
        await f.syncer.syncLocallyUpdatedFile({
            oldPath: "folder",
            relativePath: "private"
        });
    };
    await f.files.apply(next);
    assert(injected);
    assert.equal(
        Buffer.from(f.disk.userFiles().get("private/a.md") ?? []).toString(),
        "SECRET"
    );
    assert.equal(f.database.state.local["folder/a"], "private/a.md");
    assert.equal(f.database.state.excluded?.["folder/a"], "folder/a.md");
});

test("a later editor save replaces earlier unsynced text after a merge was prepared", async () => {
    const f = await fixture({ "a.md": "base" });
    const next = structuredClone(f.database.state);
    let saves = 0;
    f.disk.boundary = async (label) => {
        if (saves === 0 && label.startsWith("before:rename:a.md->")) {
            saves++;
            await f.disk.userWrite("a.md", bytes("base ONE"));
            await f.syncer.syncLocallyUpdatedFile({ relativePath: "a.md" });
        } else if (
            saves === 1 &&
            label.startsWith("before:write:") &&
            label.endsWith(".output")
        ) {
            saves++;
            await f.disk.userWrite("a.md", bytes("base TWO"));
            await f.syncer.syncLocallyUpdatedFile({ relativePath: "a.md" });
        }
    };
    await f.files.apply(next, {
        a: {
            expected: await toStoredSnapshot({ content: bytes("base") }),
            replacement: await toStoredSnapshot({
                content: bytes("base REMOTE")
            })
        }
    });
    assert.equal(saves, 2);
    assert.equal(
        Buffer.from(f.disk.userFiles().get("a.md")!).toString(),
        "base TWO REMOTE"
    );
    assert.deepEqual(f.database.state.local, { a: "a.md" });
});

test("a content save during remote application remains on the same document", async () => {
    const f = await fixture({ "a.md": "base" });
    f.database.state.documents.a.base = {
        ...head("a", 1, "base"),
        hash: f.database.state.documents.a.observedHash!
    };
    const next = structuredClone(f.database.state);
    next.documents.a.base = {
        ...head("a", 2, "base REMOTE"),
        hash: (await toStoredSnapshot({ content: bytes("base REMOTE") })).hash
    };
    let injected = false;
    f.disk.boundary = async (label) => {
        if (
            injected ||
            !label.startsWith(
                "durable:rename:a.md->.vault-link-sync/transactions/"
            )
        )
            return;
        injected = true;
        await f.disk.userWrite("a.md", bytes("base LOCAL"));
        await f.syncer.syncLocallyUpdatedFile({ relativePath: "a.md" });
    };
    await f.files.apply(next, {
        a: {
            expected: await toStoredSnapshot({ content: bytes("base") }),
            replacement: await toStoredSnapshot({
                content: bytes("base REMOTE")
            })
        }
    });

    assert.equal(f.disk.userFiles().size, 1);
    const result = Buffer.from(
        (await f.disk.readSnapshot("a.md"))!.content
    ).toString();
    assert(result.includes("LOCAL") && result.includes("REMOTE"));
});

async function setup() {
    const f = await fixture({ "a.md": "ORIGINAL", "b.md": "OTHER" });
    f.database.state.documents.a.base = {
        ...head("a", 1, "ORIGINAL"),
        hash: f.database.state.documents.a.observedHash!
    };
    const next = structuredClone(f.database.state);
    next.local = { a: "remote.md", b: "remote-b.md" };
    next.fileManifest = { fileManifestId: 3, entries: { ...next.local } };
    const expected = await toStoredSnapshot({ content: bytes("ORIGINAL") });
    const replacement = await toStoredSnapshot({
        content: bytes("ORIGINAL REMOTE")
    });
    next.documents.a.base = {
        ...head("a", 2, "ORIGINAL REMOTE"),
        hash: replacement.hash
    };
    return { f, next, writes: { a: { expected, replacement } } };
}
test("editor changes preserve exact bytes and identities at every filesystem read, mutation and persistence boundary", async (t) => {
    const { f, next, writes } = await setup();
    const labels: string[] = [];
    const trace = (l: string) => {
        labels.push(l);
    };
    f.disk.boundary = trace;
    f.persistence.boundary = trace;
    await f.files.apply(next, writes);
    const failures = [];
    let exercised = 0;
    for (const kind of ["move", "move-recreate", "delete-recreate", "save"])
        for (let target = 0; target < labels.length; target++) {
            const { f, next, writes } = await setup();
            let count = 0,
                injected = false,
                from: string | undefined;
            const boundary = async (l: string) => {
                if (injected) return;
                if (count++ !== target) return;
                const files = f.disk.userFiles();
                from = files.has("a.md")
                    ? "a.md"
                    : files.has("remote.md")
                      ? "remote.md"
                      : undefined;
                if (kind === "save" && !from) from = "a.md";
                if (!from) return;
                injected = true;
                exercised++;
                if (kind === "save") {
                    await f.disk.userWrite(
                        from,
                        bytes(
                            Buffer.from(
                                files.get(from) ?? bytes("ORIGINAL")
                            ).toString() + " LOCAL"
                        )
                    );
                    await f.syncer.syncLocallyUpdatedFile({
                        relativePath: from
                    });
                } else if (kind === "delete-recreate") {
                    await f.disk.userDelete(from);
                    await f.syncer.syncLocallyDeletedFile(from);
                } else {
                    await f.disk.userRename(from, "mine.md");
                    await f.syncer.syncLocallyUpdatedFile({
                        oldPath: from,
                        relativePath: "mine.md"
                    });
                }
                if (kind !== "move" && kind !== "save") {
                    await f.disk.userWrite(from, bytes("REPLACEMENT"));
                    await f.syncer.syncLocallyCreatedFile(from);
                }
            };
            f.disk.boundary = boundary;
            f.persistence.boundary = boundary;
            let error;
            try {
                await f.files.apply(next, writes);
            } catch (e) {
                error = String(e);
            }
            f.disk.boundary = () => {};
            f.persistence.boundary = () => {};
            try {
                await f.database.recoverPersistence();
                await f.files.recover();
                await f.internals.scan();
            } catch (e) {
                error += ";retry=" + String(e);
            }
            if (!injected) continue;
            const fs = Object.fromEntries(
                [...f.disk.userFiles()].map(([p, b]) => [
                    p,
                    Buffer.from(b).toString()
                ])
            );
            const bad =
                kind === "save"
                    ? ![
                          "ORIGINAL LOCAL REMOTE",
                          "ORIGINAL REMOTE LOCAL"
                      ].includes(fs[f.database.state.local.a]) ||
                      Object.keys(f.database.state.local).length !== 2
                    : kind === "delete-recreate"
                      ? f.database.state.local.a !== undefined
                      : f.database.state.local.a !== "mine.md" ||
                        fs["mine.md"] !== "ORIGINAL REMOTE";
            if (
                bad ||
                (kind !== "move" &&
                    kind !== "save" &&
                    fs[from!] !== "REPLACEMENT")
            )
                failures.push({
                    kind,
                    target,
                    label: labels[target],
                    error,
                    ids: f.database.state.local,
                    files: fs
                });
        }
    assert(
        exercised > 50,
        "The sweep must actually exercise the injected actions"
    );
    t.diagnostic(
        `${labels.length} boundaries; ${exercised} editor interleavings`
    );
    assert.deepEqual(failures, []);
});
