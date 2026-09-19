import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeContent, fromStoredSnapshot, toStoredSnapshot } from "./content";

const extensions = ["md"];
const snapshot = async (text: string) =>
    toStoredSnapshot({ content: new TextEncoder().encode(text) });

describe("content reconciliation without file timestamps", () => {
    it("round-trips content and editor selections without timestamps", async () => {
        const original = {
            content: new Uint8Array([0, 255, 13, 10]),
            cursors: []
        };
        assert.deepEqual(
            fromStoredSnapshot(await toStoredSnapshot(original)),
            original
        );
    });

    it("keeps local binary edits when the server content is unchanged", async () => {
        const base = await snapshot("\0base");
        const local = await snapshot("\0local");
        const merged = await mergeContent(
            "file.bin",
            base,
            local,
            base,
            extensions
        );
        assert.equal(merged.contentBase64, local.contentBase64);
    });

    it("incorporates server binary edits when local content is unchanged", async () => {
        const base = await snapshot("\0base");
        const remote = await snapshot("\0remote");
        const merged = await mergeContent(
            "file.bin",
            base,
            base,
            remote,
            extensions
        );
        assert.equal(merged.contentBase64, remote.contentBase64);
    });

    it("keeps the server on concurrent binary or unmergeable text edits", async () => {
        for (const [path, prefix] of [
            ["file.bin", "\0"],
            ["file.md", "\0"],
            ["file.json", ""]
        ]) {
            const base = await snapshot(`${prefix}base`);
            const local = await snapshot(`${prefix}local`);
            const remote = await snapshot(`${prefix}remote`);
            const merged = await mergeContent(
                path,
                base,
                local,
                remote,
                extensions
            );
            assert.equal(merged.contentBase64, remote.contentBase64, path);
        }
    });

    it("keeps the server for differing binary content without a common base", async () => {
        const local = await snapshot("\0local");
        const remote = await snapshot("\0remote");
        const merged = await mergeContent(
            "file.bin",
            undefined,
            local,
            remote,
            extensions
        );
        assert.equal(merged.contentBase64, remote.contentBase64);
    });

    it("still merges independent text edits from both sides", async () => {
        const merged = await mergeContent(
            "note.md",
            await snapshot("First paragraph.\n\nLast paragraph.\n"),
            await snapshot("Updated first paragraph.\n\nLast paragraph.\n"),
            await snapshot("First paragraph.\n\nUpdated last paragraph.\n"),
            extensions
        );
        assert.equal(
            new TextDecoder().decode(fromStoredSnapshot(merged).content),
            "Updated first paragraph.\n\nUpdated last paragraph.\n"
        );
    });
});
