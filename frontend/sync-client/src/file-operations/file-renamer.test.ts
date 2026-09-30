/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryDisk } from "../../../test-support/storage";
import { Database, createEmptyDatabase } from "../persistence/database";
import type { ServerConfig } from "../services/server-config";
import { hash } from "../utils/hash";
import { FileOperations } from "./file-operations";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("a path swap uses a conflict path only as a temporary destination", async () => {
    const disk = new MemoryDisk();
    await disk.userWrite("a.md", bytes("A"));
    await disk.userWrite("b.md", bytes("B"));
    const initial = createEmptyDatabase("test");
    initial.actualFileManifest = { a: "a.md", b: "b.md" };
    initial.documents = {
        a: { observedHash: await hash(bytes("A")) },
        b: { observedHash: await hash(bytes("B")) }
    };
    const database = new Database(
        initial,
        "test",
        async () => undefined,
        async () => undefined
    );
    const files = new FileOperations(disk, database, {} as ServerConfig);
    const renames: string[] = [];
    disk.boundary = (label): void => {
        if (label.startsWith("visible:rename:")) {
            renames.push(label.slice("visible:rename:".length));
        }
    };

    const next = structuredClone(database.state);
    next.actualFileManifest = { a: "b.md", b: "a.md" };
    await files.applyChanges(next, () => undefined);

    assert.deepEqual(renames, [
        "b.md->b (conflict b).md", // Free B without losing its contents.
        "a.md->b.md", // Move A into B.
        "b (conflict b).md->a.md" // Finish moving B into A.
    ]);
    assert.deepEqual(database.state.actualFileManifest, {
        a: "b.md",
        b: "a.md"
    });
    assert.deepEqual(
        disk.userFiles(),
        new Map([
            ["a.md", bytes("B")],
            ["b.md", bytes("A")]
        ])
    );
});
