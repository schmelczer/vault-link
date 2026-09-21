import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    Database,
    emptyState,
    type StoredDatabase
} from "../persistence/database";
import type { ServerConfig } from "../services/server-config";
import { toStoredSnapshot } from "../sync-operations/content";
import { isInternalPath } from "../utils/portable-path";
import { Logger } from "../tracing/logger";
import { FileOperations, type FileWrite } from "./file-operations";
import type {
    FileSnapshot,
    FileSystemOperations
} from "./filesystem-operations";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (snapshot: FileSnapshot) =>
    new TextDecoder().decode(snapshot.content);
const parent = (path: string) => path.split("/").slice(0, -1).join("/");

/** Atomic mutations with an injectable interruption before or after durability. */
class MemoryFiles implements FileSystemOperations {
    public readonly files = new Map<string, FileSnapshot>();
    public readonly directories = new Set([""]);
    public boundary: (label: string) => void = () => {};

    public change(label: string, action: () => void): void {
        this.boundary(`before ${label}`);
        action();
        this.boundary(`after ${label}`);
    }

    public put(path: string, value: string): void {
        for (
            let directory = parent(path);
            directory;
            directory = parent(directory)
        )
            this.directories.add(directory);
        this.files.set(path, { content: bytes(value) });
    }

    public async listFilesRecursively(root = ""): Promise<string[]> {
        assert(this.directories.has(root), `Cannot list non-directory ${root}`);
        return [...this.files.keys()].filter(
            (path) => !root || path.startsWith(`${root}/`)
        );
    }

    public async readSnapshot(path: string): Promise<FileSnapshot | undefined> {
        assert(!this.directories.has(path), `Cannot read directory ${path}`);
        return structuredClone(this.files.get(path));
    }

    public async stat(path: string) {
        for (let ancestor = parent(path); ancestor; ancestor = parent(ancestor))
            assert(
                !this.files.has(ancestor),
                `Cannot traverse file ${ancestor}`
            );
        const snapshot = this.files.get(path);
        if (snapshot)
            return { kind: "file" as const, size: snapshot.content.length };
        if (this.directories.has(path))
            return { kind: "directory" as const, size: 0 };
        return undefined;
    }

    public async exists(path: string): Promise<boolean> {
        return this.files.has(path) || this.directories.has(path);
    }

    public async createDirectory(path: string): Promise<void> {
        this.change(`mkdir ${path}`, () => {
            for (
                let directory = path;
                directory;
                directory = parent(directory)
            ) {
                assert(
                    !this.files.has(directory),
                    `File blocks directory ${directory}`
                );
                this.directories.add(directory);
            }
        });
    }

    public async write(path: string, snapshot: FileSnapshot): Promise<void> {
        this.change(`write ${path}`, () => {
            assert(
                !this.files.has(path) && !this.directories.has(path),
                `Destination exists: ${path}`
            );
            assert(
                this.directories.has(parent(path)),
                `Parent missing: ${path}`
            );
            this.files.set(path, structuredClone(snapshot));
        });
    }

    public async rename(from: string, to: string): Promise<void> {
        this.change(`rename ${from} -> ${to}`, () => {
            assert(this.files.has(from), `Source missing: ${from}`);
            assert(
                !this.files.has(to) && !this.directories.has(to),
                `Destination exists: ${to}`
            );
            assert(this.directories.has(parent(to)), `Parent missing: ${to}`);
            this.files.set(to, this.files.get(from)!);
            this.files.delete(from);
        });
    }

    public async flushPaths(paths: readonly string[]): Promise<void> {
        this.change(`flush ${paths.join(",")}`, () => {});
    }

    public async delete(path: string): Promise<void> {
        this.change(`rmdir ${path}`, () => {
            assert(!this.files.has(path));
            assert(
                ![...this.files.keys()].some((file) =>
                    file.startsWith(`${path}/`)
                )
            );
            for (const directory of this.directories)
                if (directory === path || directory.startsWith(`${path}/`))
                    this.directories.delete(directory);
        });
    }

    public async deleteFile(path: string): Promise<void> {
        this.change(`unlink ${path}`, () => {
            assert(!this.directories.has(path));
            this.files.delete(path);
        });
    }
}

async function setup(
    contents: Record<string, string>,
    local: Record<string, string>
) {
    const fs = new MemoryFiles();
    for (const [path, value] of Object.entries(contents)) fs.put(path, value);
    let durable: StoredDatabase = emptyState("test");
    durable.local = local;
    for (const [id, path] of Object.entries(local))
        durable.documents[id] = {
            materialized: true,
            observedHash: (await toStoredSnapshot(fs.files.get(path)!)).hash
        };
    const config = {
        getConfig: async () => ({ mergeableFileExtensions: ["md"] })
    } as ServerConfig;
    const restart = () => {
        const database = new Database(
            new Logger(),
            structuredClone(durable),
            async (next) => {
                fs.change("save", () => {
                    durable = structuredClone(next);
                });
            },
            "test",
            async () => structuredClone(durable)
        );
        return {
            database,
            operations: new FileOperations(fs, database, config)
        };
    };
    return { fs, restart, ...restart() };
}

async function scenario() {
    const fixture = await setup(
        {
            "a.md": "A",
            "b.md": "B",
            "c.md": "C",
            "d.md": "Unmanaged",
            "e.md": "E",
            "folder/keep.md": "Keep",
            "deleted.md": "Deleted"
        },
        { a: "a.md", b: "b.md", c: "c.md", e: "e.md", deleted: "deleted.md" }
    );
    const next = structuredClone(fixture.database.state);
    next.local = {
        a: "b.md",
        b: "a.md",
        c: "d.md",
        e: "folder",
        added: "new.md"
    };
    next.documents.added = { materialized: false };
    const writes: Record<string, FileWrite> = {
        a: {
            expected: await fixture.operations.snapshot("a.md"),
            replacement: await toStoredSnapshot({ content: bytes("A updated") })
        },
        added: {
            replacement: await toStoredSnapshot({
                content: bytes("Downloaded")
            })
        }
    };
    return { ...fixture, next, writes };
}

async function verifyScenario(fs: MemoryFiles, database: Database) {
    assert.equal(database.state.application, undefined);
    for (const [id, expected] of Object.entries({
        a: "A updated",
        b: "B",
        c: "C",
        e: "E",
        added: "Downloaded"
    })) {
        const snapshot = fs.files.get(database.state.local[id])!;
        assert.equal(text(snapshot), expected, id);
        assert.equal(database.state.documents[id].materialized, true, id);
        assert.equal(
            database.state.documents[id].observedHash,
            (await toStoredSnapshot(snapshot)).hash,
            id
        );
    }
    assert.equal(database.state.local.a, "b.md");
    assert.equal(database.state.local.b, "a.md");
    assert.equal(database.state.local.c, "d.md");
    assert.notEqual(database.state.local.e, "folder");
    assert.equal(text(fs.files.get("folder/keep.md")!), "Keep");
    assert.equal(fs.files.has("deleted.md"), false);
    assert.equal(database.state.local.deleted, undefined);
    const visible = [...fs.files].filter(([path]) => !isInternalPath(path));
    assert.deepEqual(
        visible.map(([, value]) => text(value)).sort(),
        ["A updated", "B", "C", "Downloaded", "E", "Keep", "Unmanaged"].sort()
    );
    assert.equal(
        [...fs.files.keys()].some((path) =>
            path.startsWith(".vault-link-sync/transactions/")
        ),
        false
    );
}

describe("filesystem journal recovery", () => {
    it("stages swaps, preserves unexpected files/directories, and cleans recovery artifacts", async () => {
        const { operations, database, fs, next, writes } = await scenario();
        await operations.apply(next, writes);
        await verifyScenario(fs, database);
        fs.boundary = () => {
            throw new Error("Completed recovery must not write");
        };
        await operations.recover();
    });

    it("resumes after interruption at every filesystem and metadata mutation boundary", async (t) => {
        const baseline = await scenario();
        const boundaries: string[] = [];
        baseline.fs.boundary = (label) => boundaries.push(label);
        await baseline.operations.apply(baseline.next, baseline.writes);
        for (const [index, label] of boundaries.entries()) {
            await t.test(`${index}: ${label}`, async () => {
                const fixture = await scenario();
                const interrupted = new Error("Interrupted");
                let count = 0;
                fixture.fs.boundary = () => {
                    if (count++ === index) throw interrupted;
                };
                await assert.rejects(
                    fixture.operations.apply(fixture.next, fixture.writes),
                    (error) => error === interrupted
                );
                fixture.fs.boundary = () => {};
                const { database, operations } = fixture.restart();
                if (
                    !database.state.application &&
                    database.state.local.a === "a.md"
                )
                    await operations.apply(
                        structuredClone(fixture.next),
                        fixture.writes
                    );
                else await operations.recover();
                await verifyScenario(fixture.fs, database);
            });
        }
    });

    it("merges an edit made after planning exactly once across an interrupted install", async () => {
        const base = "First paragraph.\n\nLast paragraph.\n";
        const local = "Local first paragraph.\n\nLast paragraph.\n";
        const remote = "First paragraph.\n\nRemote last paragraph.\n";
        const fixture = await setup({ "note.md": base }, { note: "note.md" });
        const expected = await fixture.operations.snapshot("note.md");
        let edited = false;
        const interrupted = new Error("Interrupted after install");
        fixture.fs.boundary = (label) => {
            if (!edited && label === "after save") {
                fixture.fs.put("note.md", local);
                edited = true;
            }
            if (
                label.startsWith("after rename ") &&
                label.endsWith(" -> note.md")
            )
                throw interrupted;
        };
        await assert.rejects(
            fixture.operations.apply(structuredClone(fixture.database.state), {
                note: {
                    expected,
                    replacement: await toStoredSnapshot({
                        content: bytes(remote)
                    })
                }
            }),
            (error) => error === interrupted
        );
        fixture.fs.boundary = () => {};
        const { operations, database } = fixture.restart();
        await operations.recover();
        assert.equal(
            text(fixture.fs.files.get("note.md")!),
            "Local first paragraph.\n\nRemote last paragraph.\n"
        );
        assert.equal(
            database.state.documents.note.observedHash,
            (await operations.snapshot("note.md"))!.hash
        );
        assert.equal(
            [...fixture.fs.files.keys()].some((path) =>
                path.startsWith(".vault-link-sync/transactions/")
            ),
            false
        );
    });

    it("preserves an external deletion between planning and staging", async () => {
        const fixture = await setup(
            { "note.md": "Local" },
            { note: "note.md" }
        );
        const expected = await fixture.operations.snapshot("note.md");
        fixture.fs.boundary = (label) => {
            if (label === "after save") fixture.fs.files.delete("note.md");
        };
        await fixture.operations.apply(
            structuredClone(fixture.database.state),
            {
                note: {
                    expected,
                    replacement: await toStoredSnapshot({
                        content: bytes("Remote")
                    })
                }
            }
        );
        assert.equal(fixture.database.state.local.note, undefined);
        assert.equal(fixture.fs.files.has("note.md"), false);
    });

    it("preserves a file created after the destination check", async () => {
        const fixture = await setup(
            { "source.md": "Incoming" },
            { doc: "source.md" }
        );
        const next = structuredClone(fixture.database.state);
        next.local.doc = "target.md";
        fixture.fs.boundary = (label) => {
            if (
                label.startsWith("before rename ") &&
                label.endsWith(" -> target.md")
            )
                fixture.fs.put("target.md", "Concurrent");
        };
        await assert.rejects(
            fixture.operations.apply(next),
            /Destination exists/
        );
        fixture.fs.boundary = () => {};
        const { operations, database } = fixture.restart();
        await operations.recover();
        assert.equal(text(fixture.fs.files.get("target.md")!), "Incoming");
        const displaced = Object.entries(database.state.local).find(
            ([id]) => id !== "doc"
        )!;
        assert.equal(text(fixture.fs.files.get(displaced[1])!), "Concurrent");
    });

    it("preserves an unexpected file blocking a destination's ancestor", async () => {
        const fixture = await setup(
            { "source.md": "Incoming", target: "Occupant" },
            { doc: "source.md" }
        );
        const next = structuredClone(fixture.database.state);
        next.local.doc = "target/child.md";
        await fixture.operations.apply(next);
        assert.equal(
            text(fixture.fs.files.get("target/child.md")!),
            "Incoming"
        );
        const displaced = Object.entries(fixture.database.state.local).find(
            ([id]) => id !== "doc"
        )!;
        assert.equal(text(fixture.fs.files.get(displaced[1])!), "Occupant");
    });

    it("handles paths becoming directories and directories becoming files", async () => {
        const fixture = await setup(
            { a: "A", "b/deep/child": "B" },
            { a: "a", b: "b/deep/child" }
        );
        const next = structuredClone(fixture.database.state);
        next.local = { a: "b", b: "a/deep/child" };
        await fixture.operations.apply(next);
        assert.equal(text(fixture.fs.files.get("b")!), "A");
        assert.equal(text(fixture.fs.files.get("a/deep/child")!), "B");
    });
});
