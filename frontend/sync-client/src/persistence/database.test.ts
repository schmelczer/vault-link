import assert from "node:assert/strict";
import { test } from "node:test";
import { Database, createEmptyDatabase } from "./database";

test("current state keeps absent optional fields absent across save and reload", async () => {
    const initial = createEmptyDatabase("vault");
    initial.actualFileManifest = { local: "local.md", remote: "remote.md" };
    initial.documents = {
        local: { observedHash: "local" },
        remote: { remote: { vaultUpdateId: 1, contentSize: 3 } },
        empty: {}
    };
    let saved = structuredClone(initial);
    const restart = (): Database =>
        new Database(
            saved,
            async (next) => {
                saved = structuredClone(next);
            },
            "vault",
            async () => structuredClone(saved)
        );
    const db = restart();
    assert.deepEqual(db.state, initial);
    await db.save();
    assert.deepEqual(saved, initial);
    assert.deepEqual(restart().state, initial);
});

test("current reset state is restored after an uncertain save", async () => {
    const saved = createEmptyDatabase("vault");
    saved.actualFileManifest = { note: "note.md" };
    saved.documents.note = {
        base: { vaultUpdateId: null, hash: "clean" },
        observedHash: "clean"
    };
    const db = new Database(
        undefined,
        async () => {
            throw new Error("interrupted");
        },
        "vault",
        async () => structuredClone(saved)
    );
    await assert.rejects(db.save(), /interrupted/);
    await db.reloadFromSave();
    assert.deepEqual(db.state, saved);
});
