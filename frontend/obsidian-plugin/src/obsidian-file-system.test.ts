import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { DataAdapter, Editor, EditorSelection } from "obsidian";
import { NodeFileSystemOperations } from "../../local-client-cli/src/node-filesystem";
import { ObsidianFileSystemOperations } from "./obsidian-file-system";
import { MobileFileSystemOperations } from "./mobile-file-system";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (content: Uint8Array) => new TextDecoder().decode(content);

test("Obsidian snapshots include unsaved editor text and restore merged selections", async (t) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "vaultlink-editor-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const disk = new NodeFileSystemOperations(root);
    await disk.write("note.md", { content: bytes("saved") });
    let value = "unsaved\ntext";
    let selections: EditorSelection[] = [
        { anchor: { line: 0, ch: 2 }, head: { line: 1, ch: 3 } }
    ];
    const editor = {
        getValue: () => value,
        listSelections: () => selections,
        setValue: (next: string) => {
            value = next;
        },
        setSelections: (next: EditorSelection[]) => {
            selections = next;
        }
    } as Editor;
    const adapter = new ObsidianFileSystemOperations(disk, () => ({
        path: "note.md",
        editor
    }));
    const snapshot = await adapter.readSnapshot("note.md");
    assert.equal(text(snapshot!.content), value);
    assert.deepEqual(snapshot!.cursors, [
        { id: 0, position: 2 },
        { id: 1, position: 11 }
    ]);
    assert.equal((await adapter.stat("note.md"))!.size, bytes(value).length);
    await assert.rejects(
        adapter.write("note.md", { content: bytes("collision") })
    );
    assert.equal(value, "unsaved\ntext");
    await adapter.deleteFile("note.md");
    await adapter.write("note.md", {
        content: bytes("new\ntext"),
        cursors: [
            { id: 1, position: 7 },
            { id: 0, position: 1 }
        ]
    });
    assert.equal(value, "new\ntext");
    assert.equal(text((await disk.readSnapshot("note.md"))!.content), value);
    assert.deepEqual(selections, [
        { anchor: { line: 0, ch: 1 }, head: { line: 1, ch: 3 } }
    ]);
    value = "edited before rename";
    selections = [{ anchor: { line: 0, ch: 1 }, head: { line: 0, ch: 4 } }];
    await adapter.rename("note.md", "moved.md");
    assert.equal(text((await disk.readSnapshot("moved.md"))!.content), value);
    assert.equal(await adapter.readSnapshot("note.md"), undefined);
});

// A storage host with Obsidian's documented semantics: writes replace, copies
// reject existing destinations. No runtime Obsidian module is needed in Node.
async function mobile(root: string) {
    const disk = new NodeFileSystemOperations(root);
    const host = {
        stat: async (p: string) => {
            const entry = await disk.stat(p);
            return entry
                ? {
                      type: entry.kind === "file" ? "file" : "folder",
                      size: entry.size,
                      mtime: 1,
                      ctime: 1
                  }
                : null;
        },
        exists: (p: string) => disk.exists(p),
        readBinary: async (p: string) =>
            new Uint8Array((await disk.readSnapshot(p))!.content).buffer,
        writeBinary: (p: string, content: ArrayBuffer) =>
            fs.writeFile(path.join(root, p), new Uint8Array(content)),
        copy: (from: string, to: string) =>
            fs.copyFile(
                path.join(root, from),
                path.join(root, to),
                constants.COPYFILE_EXCL
            ),
        mkdir: (p: string) => disk.createDirectory(p),
        remove: (p: string) => disk.deleteFile(p),
        rmdir: (p: string) => fs.rmdir(path.join(root, p)),
        list: async (p: string) => {
            const entries = await fs.readdir(path.join(root, p), {
                withFileTypes: true
            });
            return {
                files: entries
                    .filter((e) => e.isFile())
                    .map((e) => (p ? `${p}/${e.name}` : e.name)),
                folders: entries
                    .filter((e) => e.isDirectory())
                    .map((e) => (p ? `${p}/${e.name}` : e.name))
            };
        }
    } as unknown as DataAdapter;
    return { adapter: new MobileFileSystemOperations(host), host };
}

test("mobile writes use exclusive copies and never overwrite a competing writer", async (t) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "vaultlink-mobile-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { adapter } = await mobile(root);
    await adapter.createDirectory("folder/nested");
    const writes = await Promise.allSettled([
        adapter.write("folder/note.md", { content: bytes("first") }),
        adapter.write("folder/note.md", { content: bytes("second") })
    ]);
    assert.equal(writes.filter((w) => w.status === "fulfilled").length, 1);
    const original = (await adapter.readSnapshot("folder/note.md"))!;
    await adapter.write("destination.md", { content: bytes("occupied") });
    await assert.rejects(adapter.rename("folder/note.md", "destination.md"));
    assert.deepEqual(await adapter.readSnapshot("folder/note.md"), original);
    assert.equal(
        text((await adapter.readSnapshot("destination.md"))!.content),
        "occupied"
    );
    await assert.rejects(adapter.delete("folder"));
    await adapter.rename("folder/note.md", "moved.md");
    assert.deepEqual(await adapter.readSnapshot("moved.md"), original);
    await adapter.delete("folder");
    assert.equal(await adapter.exists("folder"), false);
    assert.deepEqual(await fs.readdir(path.join(root, ".vault-link-sync")), []);
    await assert.rejects(
        adapter.write("../escape", { content: bytes("bad") }),
        /Unsafe/
    );
});

test("mobile scans propagate storage errors and snapshots reject read races", async (t) => {
    const root = await fs.mkdtemp(
        path.join(tmpdir(), "vaultlink-mobile-read-")
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const { adapter, host } = await mobile(root);
    await adapter.write("note.md", { content: bytes("before") });
    const read = host.readBinary.bind(host);
    t.mock.method(host, "readBinary", async (p: string) => {
        const content = await read(p);
        await fs.writeFile(path.join(root, p), "changed length");
        return content;
    });
    await assert.rejects(
        adapter.readSnapshot("note.md"),
        /changed during read/
    );
    t.mock.method(host, "list", async () => {
        throw new Error("storage unavailable");
    });
    await assert.rejects(adapter.listFilesRecursively(), /storage unavailable/);
});
