import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ClientPersistence } from "./client-persistence";
import type { StoredClient } from "sync-client";

test("CLI persistence retains the whole record and migrates database-only saves", async (t) => {
    const directory = await fs.mkdtemp(
        path.join(tmpdir(), "vaultlink-metadata-")
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "state.json");
    const store = new ClientPersistence(file, { token: "current-token" });
    assert.deepEqual(await store.load(), {
        settings: { token: "current-token" }
    });
    const record: StoredClient = {
        settings: { token: "old-token", vaultName: "vault" },
        database: { lastSeenUpdateId: 12 },
        localChanges: [
            { type: "delete", path: "removed.md", changeId: "queued" }
        ],
        localChangesVaultKey: "vault",
        historyCheckpoint: { vaultKey: "vault", checkpoint: "12:incarnation" }
    };
    await store.save(record);
    assert.deepEqual(await store.load(), {
        ...record,
        settings: { ...record.settings, token: "current-token" }
    });
    const legacy = {
        fileManifest: { fileManifestId: 0, entries: {} },
        lastSeenUpdateId: 0
    };
    await fs.writeFile(file, JSON.stringify(legacy));
    assert.deepEqual((await store.load()).database, legacy);
    await fs.writeFile(file, "{truncated");
    await assert.rejects(store.load(), SyntaxError);
    await fs.rm(file);
    await fs.mkdir(file);
    await assert.rejects(store.load(), /EISDIR/);
});

for (const afterReplacement of [false, true]) {
    test(`failed metadata save ${afterReplacement ? "after" : "before"} replacement leaves a complete record`, async (t) => {
        const directory = await fs.mkdtemp(
            path.join(tmpdir(), "vaultlink-save-")
        );
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const store = new ClientPersistence(
            path.join(directory, "state.json"),
            {}
        );
        const old: StoredClient = {
            historyCheckpoint: { vaultKey: "v", checkpoint: "1:old" }
        };
        const next: StoredClient = {
            ...old,
            localChanges: [{ type: "delete", path: "note.md", changeId: "new" }]
        };
        await store.save(old);
        const rename = fs.rename;
        t.mock.method(
            fs,
            "rename",
            async (...args: Parameters<typeof fs.rename>) => {
                if (afterReplacement) await rename(...args);
                throw new Error("interrupted replacement");
            }
        );
        await assert.rejects(store.save(next), /interrupted replacement/);
        assert.deepEqual(await store.load(), {
            ...(afterReplacement ? next : old),
            settings: {}
        });
        assert.deepEqual(await fs.readdir(directory), ["state.json"]);
    });
}
