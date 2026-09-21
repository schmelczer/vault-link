import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, bytes, randomUUID } from "./sync-server-fixture";

for (const exclusion of ["size", "ignore"] as const)
    for (const phase of [
        "planned",
        ...(exclusion === "size" ? ["staged", "prepared"] : []),
        "installed"
    ])
        for (const recovery of [
            "none",
            "restart",
            "before:save",
            "durable:save"
        ] as const)
            test(`reenabling ${exclusion} exclusion at ${phase} preserves the content base through ${recovery}`, async () => {
                const f = await fixture();
                try {
                    const installed = phase === "installed";
                    const id = randomUUID();
                    const base = await f.put(
                        "/documents/" + id,
                        f.content("BASE\n")
                    );
                    await f.put("/file-manifest", {
                        requestId: randomUUID(),
                        parentFileManifestId: 0,
                        entries: { [id]: "a.md" }
                    });
                    await f.client.start();
                    await f.client.setSetting("isSyncEnabled", false);
                    await f.client.setSettings({
                        maxFileSizeMB:
                            exclusion === "size" ? 100 / (1024 * 1024) : 1,
                        ignorePatterns: ["private.md"]
                    });
                    const remote = await f.put(
                        "/documents/" + id,
                        f.content("REMOTE\nBASE\n", base.vaultUpdateId)
                    );
                    const local = "BASE\n" + "LOCAL\n".repeat(30);
                    const path = exclusion === "size" ? "a.md" : "private.md";
                    let injected = false,
                        armed = false,
                        crashed = false;
                    f.disk.boundary = async (label) => {
                        const atBoundary =
                            phase === "installed"
                                ? label.startsWith("durable:rename:") &&
                                  label.endsWith(".output->a.md")
                                : phase === "staged"
                                  ? label.startsWith("durable:rename:a.md->")
                                  : phase === "prepared"
                                    ? label.startsWith("before:write:") &&
                                      label.endsWith(".output")
                                    : label.startsWith(
                                          "before:mkdir:.vault-link-sync/transactions/"
                                      );
                        if (injected || !atBoundary) return;
                        injected = true;
                        if (exclusion === "ignore")
                            await f.disk.userRename("a.md", path);
                        // When installation already completed, deleting REMOTE
                        // is a subsequent local edit, which must not be undone.
                        await f.disk.userWrite(path, bytes(local));
                        await f.client.syncLocallyUpdatedFile({
                            relativePath: path,
                            ...(exclusion === "ignore"
                                ? { oldPath: "a.md" }
                                : {})
                        });
                        armed = true;
                    };
                    f.store.boundary = (label) => {
                        if (!armed || crashed || label !== recovery) return;
                        crashed = true;
                        f.disk.crash(true);
                        throw new Error("interrupted exclusion save");
                    };
                    if (recovery.endsWith(":save")) {
                        await assert.rejects(
                            f.client.setSetting("isSyncEnabled", true),
                            /interrupted exclusion save/
                        );
                        assert(crashed);
                    } else await f.client.setSetting("isSyncEnabled", true);
                    assert(injected);
                    f.disk.boundary = f.store.boundary = () => {};
                    if (recovery !== "none") {
                        await f.reopenClient();
                        await f.client.start();
                    }

                    assert.deepEqual(
                        (await f.disk.readSnapshot(path))?.content,
                        bytes(local)
                    );
                    const stored = f.store.snapshot().database!;
                    assert.equal(
                        stored.documents![id].base?.vaultUpdateId,
                        installed ? remote.vaultUpdateId : base.vaultUpdateId
                    );
                    assert.equal(
                        stored.remoteHeads![id].vaultUpdateId,
                        remote.vaultUpdateId
                    );
                    assert.equal(
                        (await f.get("/documents/" + id)).contentBase64,
                        Buffer.from("REMOTE\nBASE\n").toString("base64")
                    );
                    await f.client.setSettings({
                        maxFileSizeMB: 1,
                        ignorePatterns: []
                    });
                    const expected = installed ? local : "REMOTE\n" + local;
                    const verify = async () => {
                        assert.deepEqual(
                            (await f.get("/file-manifest")).entries,
                            { [id]: path }
                        );
                        assert.deepEqual(
                            (await f.disk.readSnapshot(path))?.content,
                            bytes(expected)
                        );
                        assert.equal(
                            (await f.get("/documents/" + id)).contentBase64,
                            Buffer.from(expected).toString("base64")
                        );
                    };
                    await verify();
                    await f.client.reset();
                    await verify();
                } finally {
                    await f.dispose();
                }
            });

for (const at of [undefined, "before:save", "durable:save"])
    for (const powerLoss of at ? [false, true] : [false])
        test(`repeated saves retain only the latest local edit through ${at ?? "completion"} and powerLoss=${powerLoss}`, async () => {
            const f = await fixture();
            try {
                const id = randomUUID();
                const base = await f.put("/documents/" + id, f.content("base"));
                await f.put("/file-manifest", {
                    requestId: randomUUID(),
                    parentFileManifestId: 0,
                    entries: { [id]: "a.md" }
                });
                await f.client.start();
                await f.client.setSetting("isSyncEnabled", false);
                await f.put(
                    "/documents/" + id,
                    f.content("base REMOTE", base.vaultUpdateId)
                );
                let saves = 0,
                    armed = false,
                    crashed = false;
                f.disk.boundary = async (label) => {
                    if (
                        saves === 0 &&
                        label.startsWith("before:rename:a.md->")
                    ) {
                        saves++;
                        await f.disk.userWrite("a.md", bytes("base ONE"));
                        await f.client.syncLocallyUpdatedFile({
                            relativePath: "a.md"
                        });
                    } else if (
                        saves === 1 &&
                        label.startsWith("before:write:") &&
                        label.endsWith(".output")
                    ) {
                        saves++;
                        await f.disk.userWrite("a.md", bytes("base TWO"));
                        await f.client.syncLocallyUpdatedFile({
                            relativePath: "a.md"
                        });
                        armed = true;
                    }
                };
                f.store.boundary = (label) => {
                    if (!armed || crashed || label !== at) return;
                    crashed = true;
                    f.disk.crash(powerLoss);
                    throw new Error("injected repeated-save crash");
                };
                if (at) {
                    await assert.rejects(
                        f.client.setSetting("isSyncEnabled", true),
                        /injected repeated-save crash/
                    );
                    assert(crashed);
                    f.disk.boundary = () => {};
                    f.store.boundary = () => {};
                    await f.reopenClient();
                    await f.client.start();
                } else await f.client.setSetting("isSyncEnabled", true);
                assert.equal(saves, 2);
                const verify = async () => {
                    assert.deepEqual((await f.get("/file-manifest")).entries, {
                        [id]: "a.md"
                    });
                    assert.deepEqual(
                        (await f.disk.readSnapshot("a.md"))?.content,
                        bytes("base TWO REMOTE")
                    );
                    assert.equal(
                        Buffer.from(
                            (await f.get("/documents/" + id)).contentBase64,
                            "base64"
                        ).toString(),
                        "base TWO REMOTE"
                    );
                };
                await verify();
                await f.client.reset();
                await verify();
            } finally {
                await f.dispose();
            }
        });

for (const timing of ["before", "durable"])
    for (const crash of [false, true])
        test(`oversized save ${timing} staging stays local across crash=${crash}`, async () => {
            const f = await fixture();
            try {
                const id = randomUUID(),
                    large = "PRIVATE".repeat(100);
                const base = await f.put(
                    "/documents/" + id,
                    f.content("PUBLIC")
                );
                await f.put("/file-manifest", {
                    requestId: randomUUID(),
                    parentFileManifestId: 0,
                    entries: { [id]: "a.bin" }
                });
                await f.client.start();
                await f.client.setSetting("isSyncEnabled", false);
                await f.client.setSetting("maxFileSizeMB", 100 / (1024 * 1024));
                await f.put(
                    "/documents/" + id,
                    f.content("REMOTE", base.vaultUpdateId)
                );
                let injected = false,
                    armed = false,
                    crashed = false;
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
                    await f.client.syncLocallyUpdatedFile({
                        relativePath: "a.bin"
                    });
                    armed = true;
                };
                f.store.boundary = (label) => {
                    if (!crash || !armed || crashed || label !== "durable:save")
                        return;
                    crashed = true;
                    f.disk.crash(true);
                    throw new Error("injected oversized-save crash");
                };
                if (crash) {
                    await assert.rejects(
                        f.client.setSetting("isSyncEnabled", true),
                        /injected oversized-save crash/
                    );
                    assert(crashed);
                    f.disk.boundary = () => {};
                    f.store.boundary = () => {};
                    await f.reopenClient();
                    await f.client.start();
                } else await f.client.setSetting("isSyncEnabled", true);
                assert(injected);
                const verify = async () => {
                    assert.deepEqual(
                        (await f.disk.readSnapshot("a.bin"))?.content,
                        bytes(large)
                    );
                    assert.deepEqual((await f.get("/file-manifest")).entries, {
                        [id]: "a.bin"
                    });
                    assert.equal(
                        Buffer.from(
                            (await f.get("/documents/" + id)).contentBase64,
                            "base64"
                        ).toString(),
                        "REMOTE"
                    );
                };
                await verify();
                await f.client.reset();
                await verify();
            } finally {
                await f.dispose();
            }
        });

test("a tracked file moved into an ignored path during remote application never uploads its new bytes", async () => {
    const f = await fixture();
    try {
        const a = randomUUID(),
            b = randomUUID();
        await f.put("/documents/" + a, f.content("PUBLIC"));
        await f.put("/documents/" + b, f.content("OTHER"));
        const m = await f.put("/file-manifest", {
            requestId: randomUUID(),
            parentFileManifestId: 0,
            entries: { [a]: "a.md", [b]: "b.md" }
        });
        await f.client.setSetting("ignorePatterns", ["private.md"]);
        await f.client.start();
        await f.client.setSetting("isSyncEnabled", false);
        await f.put("/file-manifest", {
            requestId: randomUUID(),
            parentFileManifestId: m.fileManifestId,
            entries: { [a]: "a.md", [b]: "remote-b.md" }
        });
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
            await f.client.syncLocallyUpdatedFile({
                oldPath: "a.md",
                relativePath: "private.md"
            });
        };
        await f.client.setSetting("isSyncEnabled", true);
        assert(injected);
        const manifest = await f.get("/file-manifest");
        const contents = await Promise.all(
            Object.keys(manifest.entries).map((id) => f.get("/documents/" + id))
        );
        assert(
            !contents.some(
                (c) =>
                    Buffer.from(c.contentBase64, "base64").toString() ===
                    "SECRET"
            )
        );
        assert.deepEqual(
            (await f.disk.readSnapshot("private.md"))?.content,
            bytes("SECRET")
        );
        assert.equal(manifest.entries[a], "a.md");
    } finally {
        await f.dispose();
    }
});
test("remote creation plus unrelated notification must not delete remote membership on retry", async () => {
    const f = await fixture();
    try {
        await f.client.start();
        await f.client.setSetting("isSyncEnabled", false);
        const id = randomUUID();
        await f.put("/documents/" + id, f.content("REMOTE"));
        await f.put("/file-manifest", {
            requestId: randomUUID(),
            parentFileManifestId: 0,
            entries: { [id]: "remote.md" }
        });
        let injected = false;
        f.disk.boundary = async (label) => {
            if (
                injected ||
                !label.startsWith("before:mkdir:.vault-link-sync/transactions/")
            )
                return;
            injected = true;
            await f.disk.userWrite("local.md", bytes("LOCAL"));
            await f.client.syncLocallyCreatedFile("local.md");
        };
        await f.client.setSetting("isSyncEnabled", true);
        assert(injected);
        f.disk.boundary = () => {};
        await f.client.reset();
        const manifest = await f.get("/file-manifest");

        assert.equal(manifest.entries[id], "remote.md");
    } finally {
        await f.dispose();
    }
});
test("notified ignored occupant during remote rename must never upload its bytes", async () => {
    const f = await fixture();
    try {
        const id = randomUUID();
        await f.put("/documents/" + id, f.content("REMOTE"));
        const m = await f.put("/file-manifest", {
            requestId: randomUUID(),
            parentFileManifestId: 0,
            entries: { [id]: "a.md" }
        });
        await f.client.setSetting("ignorePatterns", ["private"]);
        await f.client.start();
        await f.client.setSetting("isSyncEnabled", false);
        await f.put("/file-manifest", {
            requestId: randomUUID(),
            parentFileManifestId: m.fileManifestId,
            entries: { [id]: "private/note.md" }
        });
        let injected = false;
        f.disk.boundary = async (label) => {
            if (
                injected ||
                !label.startsWith("before:mkdir:.vault-link-sync/transactions/")
            )
                return;
            injected = true;
            await f.disk.userWrite("private", bytes("SECRET"));
            await f.client.syncLocallyCreatedFile("private");
        };
        await f.client.setSetting("isSyncEnabled", true);
        f.disk.boundary = () => {};
        const manifest = await f.get("/file-manifest");
        const contents = await Promise.all(
            Object.keys(manifest.entries).map((id) => f.get("/documents/" + id))
        );

        assert(injected);
        assert.deepEqual(
            (await f.disk.readSnapshot("private"))?.content,
            bytes("SECRET")
        );
        assert(
            !contents.some(
                (c) =>
                    Buffer.from(c.contentBase64, "base64").toString() ===
                    "SECRET"
            )
        );
    } finally {
        await f.dispose();
    }
});
test("notified delete/recreate before staging retains replacement file", async () => {
    const f = await fixture();
    try {
        const id = randomUUID();
        const h = await f.put("/documents/" + id, f.content("ORIGINAL"));
        const m = await f.put("/file-manifest", {
            requestId: randomUUID(),
            parentFileManifestId: 0,
            entries: { [id]: "a.md" }
        });
        await f.client.start();
        await f.client.setSetting("isSyncEnabled", false);
        await f.put(
            "/documents/" + id,
            f.content("ORIGINAL REMOTE", h.vaultUpdateId)
        );
        await f.put("/file-manifest", {
            requestId: randomUUID(),
            parentFileManifestId: m.fileManifestId,
            entries: { [id]: "remote.md" }
        });
        let injected = false;
        f.disk.boundary = async (label) => {
            if (
                injected ||
                !label.startsWith(
                    "before:rename:a.md->.vault-link-sync/transactions/"
                )
            )
                return;
            injected = true;
            await f.disk.userDelete("a.md");
            await f.client.syncLocallyDeletedFile("a.md");
            await f.disk.userWrite("a.md", bytes("REPLACEMENT"));
            await f.client.syncLocallyCreatedFile("a.md");
        };
        await f.client.setSetting("isSyncEnabled", true);
        f.disk.boundary = () => {};
        const manifest = await f.get("/file-manifest");

        assert.deepEqual(
            (await f.disk.readSnapshot("a.md"))?.content,
            bytes("REPLACEMENT")
        );
    } finally {
        await f.dispose();
    }
});

for (const mode of ["delete", "move", "save"] as const)
    for (const powerLoss of [false, true])
        for (const at of ["before:save", "durable:save"])
            test(`${mode} during staging survives ${at} and ${powerLoss ? "power loss" : "process replacement"}`, async () => {
                const f = await fixture();
                try {
                    const id = randomUUID();
                    const h = await f.put(
                        "/documents/" + id,
                        f.content("ORIGINAL")
                    );
                    await f.put("/file-manifest", {
                        requestId: randomUUID(),
                        parentFileManifestId: 0,
                        entries: { [id]: "a.md" }
                    });
                    await f.client.start();
                    await f.client.setSetting("isSyncEnabled", false);
                    await f.put(
                        "/documents/" + id,
                        f.content("ORIGINAL REMOTE", h.vaultUpdateId)
                    );
                    let injected = false,
                        armed = false,
                        crashed = false;
                    f.disk.boundary = async (label) => {
                        const point = mode === "save" ? "durable" : "before";
                        if (
                            injected ||
                            !label.startsWith(
                                `${point}:rename:a.md->.vault-link-sync/transactions/`
                            )
                        )
                            return;
                        injected = true;
                        if (mode === "save") {
                            await f.disk.userWrite(
                                "a.md",
                                bytes("ORIGINAL LOCAL")
                            );
                            await f.client.syncLocallyUpdatedFile({
                                relativePath: "a.md"
                            });
                        } else {
                            if (mode === "delete") {
                                await f.disk.userDelete("a.md");
                                await f.client.syncLocallyDeletedFile("a.md");
                            } else {
                                await f.disk.userRename("a.md", "mine.md");
                                await f.client.syncLocallyUpdatedFile({
                                    oldPath: "a.md",
                                    relativePath: "mine.md"
                                });
                            }
                            await f.disk.userWrite(
                                "a.md",
                                bytes("REPLACEMENT")
                            );
                            await f.client.syncLocallyCreatedFile("a.md");
                        }
                        armed = true;
                    };
                    f.store.boundary = (label) => {
                        if (!armed || crashed || label !== at) return;
                        crashed = true;
                        f.disk.crash(powerLoss);
                        throw new Error("injected journal crash");
                    };
                    await assert.rejects(
                        f.client.setSetting("isSyncEnabled", true),
                        /injected journal crash/
                    );
                    assert(injected && crashed);
                    f.disk.boundary = () => {};
                    f.store.boundary = () => {};
                    await f.reopenClient();
                    await f.client.start();
                    const manifest = await f.get("/file-manifest");
                    if (mode === "save") {
                        assert.deepEqual(manifest.entries, { [id]: "a.md" });
                        const actual = Buffer.from(
                            (await f.disk.readSnapshot("a.md"))!.content
                        ).toString();
                        assert.equal(actual, "ORIGINAL LOCAL REMOTE");
                    } else {
                        assert.deepEqual(
                            (await f.disk.readSnapshot("a.md"))?.content,
                            bytes("REPLACEMENT")
                        );
                        assert.notEqual(
                            Object.keys(manifest.entries).find(
                                (key) => manifest.entries[key] === "a.md"
                            ),
                            id
                        );
                        if (mode === "move") {
                            assert.equal(manifest.entries[id], "mine.md");
                            assert.deepEqual(
                                (await f.disk.readSnapshot("mine.md"))?.content,
                                bytes("ORIGINAL REMOTE")
                            );
                        } else assert.equal(manifest.entries[id], undefined);
                    }
                    await f.client.reset();
                    assert.deepEqual(
                        (await f.get("/file-manifest")).entries,
                        manifest.entries
                    );
                } finally {
                    await f.dispose();
                }
            });
