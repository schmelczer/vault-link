import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toHashedSnapshot, type HashedSnapshot } from "../snapshot";
import { mergeContent } from "./content";

const extensions = ["md"];
const createSnapshot = async (text: string): Promise<HashedSnapshot> =>
    toHashedSnapshot({ content: new TextEncoder().encode(text) });

describe("content reconciliation without file timestamps", () => {
    it("hashes snapshots without changing bytes or editor selections", async () => {
        const original = {
            content: new Uint8Array([0, 255, 13, 10]),
            cursors: []
        };
        const snapshot = await toHashedSnapshot(original);
        assert.deepEqual(snapshot.content, original.content);
        assert.deepEqual(snapshot.cursors, original.cursors);
        original.content.fill(1);
        assert.deepEqual(snapshot.content, new Uint8Array([0, 255, 13, 10]));
    });

    it("keeps local binary edits when the server content is unchanged", async () => {
        const base = await createSnapshot("\0base");
        const local = await createSnapshot("\0local");
        const merged = await mergeContent(
            "file.bin",
            base,
            local,
            base,
            extensions
        );
        assert.deepEqual(merged.content, local.content);
    });

    it("incorporates server binary edits when local content is unchanged", async () => {
        const base = await createSnapshot("\0base");
        const remote = await createSnapshot("\0remote");
        const merged = await mergeContent(
            "file.bin",
            base,
            base,
            remote,
            extensions
        );
        assert.deepEqual(merged.content, remote.content);
    });

    it("keeps the server on concurrent binary or unmergeable text edits", async () => {
        for (const [path, prefix] of [
            ["file.bin", "\0"],
            ["file.md", "\0"],
            ["file.json", ""]
        ] as const) {
            const base = await createSnapshot(`${prefix}base`);
            const local = await createSnapshot(`${prefix}local`);
            const remote = await createSnapshot(`${prefix}remote`);
            const merged = await mergeContent(
                path,
                base,
                local,
                remote,
                extensions
            );
            assert.deepEqual(merged.content, remote.content, path);
        }
    });

    it("keeps the server for differing binary content without a common base", async () => {
        const local = await createSnapshot("\0local");
        const remote = await createSnapshot("\0remote");
        const merged = await mergeContent(
            "file.bin",
            undefined,
            local,
            remote,
            extensions
        );
        assert.deepEqual(merged.content, remote.content);
    });

    it("still merges independent text edits from both sides", async () => {
        const merged = await mergeContent(
            "note.md",
            await createSnapshot("First paragraph.\n\nLast paragraph.\n"),
            await createSnapshot(
                "Updated first paragraph.\n\nLast paragraph.\n"
            ),
            await createSnapshot(
                "First paragraph.\n\nUpdated last paragraph.\n"
            ),
            extensions
        );
        assert.equal(
            new TextDecoder().decode(merged.content),
            "Updated first paragraph.\n\nUpdated last paragraph.\n"
        );
    });
});
