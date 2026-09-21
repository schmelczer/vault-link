import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, bytes, randomUUID } from "./sync-server-fixture";
import { readdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
for (const mode of [
    "same-version",
    "behind",
    "dirty",
    "pending",
    "legacy-state",
    ...["before:save", "durable:save"].flatMap((boundary) =>
        [1, 2, 3, 4, 5].map((ordinal) => `${boundary}:${ordinal}`)
    )
] as const)
    test(`restored history recovers ${mode} without false convergence or lost local work`, async () => {
        const f = await fixture();
        const crashRecovery = mode.includes(":save:");
        const hasLocalEdit =
            mode === "dirty" || mode === "pending" || crashRecovery;
        try {
            const id = randomUUID();
            const h = await f.put("/documents/" + id, f.content("BASE"));
            await f.put("/file-manifest", {
                requestId: randomUUID(),
                parentFileManifestId: 0,
                entries: { [id]: "a.md" }
            });
            await f.client.start();
            await f.client.setSetting("isSyncEnabled", false);
            const vaults = join(f.server.databaseDirectory, "vaults");
            const db = join(
                vaults,
                (await readdir(vaults)).find((p) => p.endsWith(".sqlite"))!
            );
            const backup = db + ".backup";
            execFileSync("python3", [
                "-c",
                "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()",
                db,
                backup
            ]);
            const old = await f.put(
                "/documents/" + id,
                f.content("OLD BRANCH", h.vaultUpdateId)
            );
            await f.client.setSetting("isSyncEnabled", true);
            await f.client.setSetting("isSyncEnabled", false);
            assert.equal(
                Buffer.from(
                    (await f.disk.readSnapshot("a.md"))!.content
                ).toString(),
                "OLD BRANCH"
            );
            if (hasLocalEdit) {
                await f.disk.userWrite("a.md", bytes("OLD BRANCH LOCAL"));
                await f.client.syncLocallyUpdatedFile({ relativePath: "a.md" });
            }
            if (mode === "pending") {
                // Lose an acknowledgement after the server committed, leaving a
                // durable request that must not be retried against the restored DB.
                f.setFetchHook(async (input, init) => {
                    const response = await fetch(input, init);
                    if (init?.method === "PUT")
                        throw new Error("lost acknowledgement");
                    return response;
                });
                await assert.rejects(
                    f.client.setSetting("isSyncEnabled", true),
                    /lost acknowledgement/
                );
                await f.client.setSetting("isSyncEnabled", false);
                f.setFetchHook(fetch);
            }
            await f.server.crash();
            await copyFile(backup, db);
            await rm(db + "-wal", { force: true });
            await rm(db + "-shm", { force: true });
            await f.server.restart();
            const fork =
                mode === "behind"
                    ? h
                    : await f.put(
                          "/documents/" + id,
                          f.content("NEW BRANCH", h.vaultUpdateId)
                      );
            if (mode !== "behind")
                assert.equal(fork.vaultUpdateId, old.vaultUpdateId);
            let interrupted = false,
                mismatch = false;
            if (crashRecovery) {
                const boundary = mode.split(":").slice(0, 2).join(":");
                const ordinal = Number(mode.split(":")[2]);
                let saves = 0;
                f.setFetchHook(async (input, init) => {
                    const response = await fetch(input, init);
                    if (
                        response.headers.get(
                            "x-vault-link-history-mismatch"
                        ) === "1"
                    )
                        mismatch = true;
                    return response;
                });
                f.store.boundary = (label) => {
                    if (
                        mismatch &&
                        !interrupted &&
                        label === boundary &&
                        ++saves === ordinal
                    ) {
                        // Sweep the scan, durable reset intent, checkpoint
                        // replacement and final bootstrap-enabling saves.
                        interrupted = true;
                        throw new Error("interrupted recovery save");
                    }
                };
                await assert.rejects(
                    f.client.setSetting("isSyncEnabled", true)
                );
                assert(interrupted && mismatch);
                f.store.boundary = () => {};
                await f.reopenClient();
                await f.client.start();
            }
            if (mode === "legacy-state") {
                await f.client.destroy();
                const stored = f.store.snapshot() as ReturnType<
                    typeof f.store.snapshot
                > & { historyCheckpoint?: unknown };
                delete stored.historyCheckpoint;
                await f.store.save(stored);
                await f.reopenClient();
                await f.client.start();
            }
            await f.client.setSetting("isSyncEnabled", true);
            const actual = Buffer.from(
                (await f.disk.readSnapshot("a.md"))!.content
            ).toString();
            const remote = Buffer.from(
                (await f.get("/documents/" + id)).contentBase64,
                "base64"
            ).toString();

            assert.equal(actual, remote);
            assert.equal(remote, mode === "behind" ? "BASE" : "NEW BRANCH");
            if (hasLocalEdit) {
                const manifest = await f.get("/file-manifest");
                const recovered = Object.keys(manifest.entries).filter(
                    (other) => other !== id
                );
                assert.equal(recovered.length, 1);
                assert.equal(
                    Buffer.from(
                        (await f.get("/documents/" + recovered[0]))
                            .contentBase64,
                        "base64"
                    ).toString(),
                    "OLD BRANCH LOCAL"
                );
                assert.equal(
                    Buffer.from(
                        f.disk.userFiles().get(manifest.entries[recovered[0]])!
                    ).toString(),
                    "OLD BRANCH LOCAL"
                );
            }
            await f.client.reset();
            assert.equal(
                Buffer.from(
                    (await f.disk.readSnapshot("a.md"))!.content
                ).toString(),
                remote
            );
        } finally {
            await f.dispose();
        }
    });
