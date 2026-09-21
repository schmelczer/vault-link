import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, bytes, randomUUID } from "./sync-server-fixture";
import { assertCanonical } from "./canonical";
import { SyncClient } from "../sync-client/src/sync-client";
import { MemoryDisk, MemoryPersistence } from "./storage";

for (const powerLoss of [false, true])
    for (const operation of ["create", "replace", "move", "metadata"] as const)
        test(
            `${operation}: a ${powerLoss ? "power" : "process"} interruption and later user edits converge without replay`,
            { timeout: 20_000 },
            async () => {
                const f = await fixture();
                let peer: SyncClient | undefined;
                try {
                    const id = randomUUID();
                    const head = await f.put(
                        `/documents/${id}`,
                        f.content("BASE\n")
                    );
                    const manifest = await f.put("/file-manifest", {
                        requestId: randomUUID(),
                        parentFileManifestId: 0,
                        entries: { [id]: "note.md" }
                    });
                    if (operation !== "create") {
                        await f.client.start();
                        await f.client.setSetting("isSyncEnabled", false);
                        if (operation === "move")
                            await f.put("/file-manifest", {
                                requestId: randomUUID(),
                                parentFileManifestId: manifest.fileManifestId,
                                entries: { [id]: "moved.md" }
                            });
                        else
                            await f.put(
                                `/documents/${id}`,
                                f.content("REMOTE\nBASE\n", head.vaultUpdateId)
                            );
                    }
                    let fired = false;
                    let wrote = false;
                    const interrupt = () => {
                        fired = true;
                        f.disk.crash(powerLoss);
                        throw new Error("injected interruption");
                    };
                    f.disk.boundary = (label) => {
                        if (fired) return;
                        if (label === "durable:write:note.md") wrote = true;
                        if (
                            operation === "move" &&
                            label === "visible:rename:note.md->moved.md"
                        )
                            interrupt();
                        if (
                            (operation === "create" ||
                                operation === "replace") &&
                            label === "visible:write:note.md"
                        )
                            interrupt();
                    };
                    f.store.boundary = (label) => {
                        if (
                            !fired &&
                            operation === "metadata" &&
                            wrote &&
                            label === "before:save"
                        )
                            interrupt();
                    };
                    await assert.rejects(
                        operation === "create"
                            ? f.client.start()
                            : f.client.setSetting("isSyncEnabled", true),
                        /injected interruption/
                    );
                    assert(
                        fired,
                        "The intended filesystem/save boundary must be reached"
                    );
                    f.disk.boundary = () => {};
                    f.store.boundary = () => {};
                    // Model torn content and further independent edits. Neither is
                    // recoverable from an old filesystem intention, nor should it be.
                    await f.disk.userWrite(
                        operation === "move" ? "moved.md" : "note.md",
                        bytes("partial\nUSER EDIT\n")
                    );
                    await f.disk.userWrite(
                        "after.md",
                        bytes("AFTER INTERRUPTION\n")
                    );
                    await f.reopenClient();
                    await f.client.start();
                    const inspectable = {
                        files: () => f.disk.userFiles(),
                        database: () => f.store.snapshot().database
                    };
                    const peerDisk = new MemoryDisk();
                    const peerStore = new MemoryPersistence({
                        settings: f.store.snapshot().settings
                    });
                    peer = await SyncClient.create({
                        fs: peerDisk,
                        persistence: peerStore
                    });
                    await peer.start();
                    const clients = [
                        inspectable,
                        {
                            files: () => peerDisk.userFiles(),
                            database: () => peerStore.snapshot().database
                        }
                    ];
                    await assertCanonical(
                        clients,
                        f.url,
                        "test-token-change-me"
                    );
                    assert.deepEqual(
                        f.disk.userFiles().get("after.md"),
                        bytes("AFTER INTERRUPTION\n")
                    );
                    assert(
                        (await f.disk.listFilesRecursively()).every(
                            (path) => !path.startsWith(".vault-link-sync/")
                        )
                    );
                    const files = f.disk.userFiles();
                    await f.reopenClient();
                    await f.client.start();
                    await assertCanonical(
                        clients,
                        f.url,
                        "test-token-change-me"
                    );
                    assert.deepEqual(
                        f.disk.userFiles(),
                        files,
                        "A second restart must not replay old writes"
                    );
                } finally {
                    f.disk.boundary = () => {};
                    f.store.boundary = () => {};
                    await peer?.destroy();
                    await f.dispose();
                }
            }
        );

for (const operation of ["create", "replace", "move"] as const)
    test(
        `${operation}: metadata can survive while completed user-file writes are lost`,
        { timeout: 20_000 },
        async () => {
            const f = await fixture();
            let peer: SyncClient | undefined;
            try {
                const id = randomUUID();
                const head = await f.put(
                    `/documents/${id}`,
                    f.content("BASE\n")
                );
                const manifest = await f.put("/file-manifest", {
                    requestId: randomUUID(),
                    parentFileManifestId: 0,
                    entries: { [id]: "note.md" }
                });
                if (operation !== "create") {
                    await f.client.start();
                    await f.client.setSetting("isSyncEnabled", false);
                    if (operation === "replace")
                        await f.put(
                            `/documents/${id}`,
                            f.content("REMOTE\nBASE\n", head.vaultUpdateId)
                        );
                    else
                        await f.put("/file-manifest", {
                            requestId: randomUUID(),
                            parentFileManifestId: manifest.fileManifestId,
                            entries: { [id]: "moved.md" }
                        });
                }
                const oldDisk = f.disk.image();
                if (operation === "create") await f.client.start();
                else await f.client.setSetting("isSyncEnabled", true);
                await f.client.destroy();
                // Metadata is newer than disk: completed filesystem calls have no
                // flush contract. This is not covered by failing a call mid-flight.
                f.disk.restore(oldDisk);
                await f.disk.userWrite(
                    "after.md",
                    bytes("USER AFTER POWER LOSS\n")
                );
                await f.reopenClient();
                await f.client.start();
                const peerDisk = new MemoryDisk();
                const peerStore = new MemoryPersistence({
                    settings: f.store.snapshot().settings
                });
                peer = await SyncClient.create({
                    fs: peerDisk,
                    persistence: peerStore
                });
                await peer.start();
                await assertCanonical(
                    [
                        {
                            files: () => f.disk.userFiles(),
                            database: () => f.store.snapshot().database
                        },
                        {
                            files: () => peerDisk.userFiles(),
                            database: () => peerStore.snapshot().database
                        }
                    ],
                    f.url,
                    "test-token-change-me"
                );
                assert.deepEqual(
                    f.disk.userFiles().get("after.md"),
                    bytes("USER AFTER POWER LOSS\n")
                );
            } finally {
                await peer?.destroy();
                await f.dispose();
            }
        }
    );
