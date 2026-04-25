import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RelativePath } from "../sync-operations/types";
import type { SyncEventQueue } from "../sync-operations/sync-event-queue";
import { FileOperations } from "./file-operations";
import { Logger } from "../tracing/logger";
import { assertSetContainsExactly } from "../utils/assert-set-contains-exactly";
import type { FileSystemOperations } from "./filesystem-operations";
import type { TextWithCursors } from "reconcile-text";
import type { ServerConfig, ServerConfigData } from "../services/server-config";
import { CONFLICT_PATH_REGEX } from "../sync-operations/conflict-path";

class MockServerConfig implements Pick<ServerConfig, "getConfig"> {
    public async getConfig(): Promise<ServerConfigData> {
        return {
            mergeableFileExtensions: ["md", "txt"],
            supportedApiVersion: 1,
            isAuthenticated: true
        };
    }
}

// The queue only receives `moveDocument`/`removeDocument` from file-ops; for
// these tests we just need no-op implementations that let the type-check
// pass when cast to `SyncEventQueue`.
class MockQueue implements Pick<SyncEventQueue, "moveDocument" | "removeDocument"> {
    public moveDocument(
        _oldPath: RelativePath,
        _newPath: RelativePath
    ): void {
        // no-op
    }

    public removeDocument(_path: RelativePath): void {
        // no-op
    }
}

class FakeFileSystemOperations implements FileSystemOperations {
    public readonly names = new Set<string>();

    public async listFilesRecursively(
        _root: RelativePath | undefined
    ): Promise<RelativePath[]> {
        return Array.from(this.names);
    }
    public async read(_path: RelativePath): Promise<Uint8Array> {
        throw new Error("Method not implemented.");
    }
    public async write(
        path: RelativePath,
        _content: Uint8Array
    ): Promise<void> {
        this.names.add(path);
    }
    public async atomicUpdateText(
        _path: RelativePath,
        _updater: (current: TextWithCursors) => TextWithCursors
    ): Promise<string> {
        throw new Error("Method not implemented.");
    }
    public async getFileSize(_path: RelativePath): Promise<number> {
        throw new Error("Method not implemented.");
    }
    public async getModificationTime(_path: RelativePath): Promise<Date> {
        throw new Error("Method not implemented.");
    }
    public async exists(path: RelativePath): Promise<boolean> {
        return this.names.has(path);
    }
    public async delete(_path: RelativePath): Promise<void> {
        throw new Error("Method not implemented.");
    }
    public async rename(
        oldPath: RelativePath,
        newPath: RelativePath
    ): Promise<void> {
        this.names.delete(oldPath);
        this.names.add(newPath);
    }
}

function makeOps(): {
    fs: FakeFileSystemOperations;
    ops: FileOperations;
} {
    const fs = new FakeFileSystemOperations();
    const ops = new FileOperations(
        new Logger(),
        new MockQueue() as SyncEventQueue, // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
        fs,
        new MockServerConfig() as ServerConfig // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
    );
    return { fs, ops };
}

function singleConflictPath(
    names: Set<string>,
    expectedNonConflictNames: string[]
): string {
    const expected = new Set(expectedNonConflictNames);
    const conflicts = Array.from(names).filter(
        (name) => !expected.has(name)
    );
    assert.equal(
        conflicts.length,
        1,
        `expected exactly one conflict-path entry, got ${JSON.stringify(conflicts)}`
    );
    assert.ok(
        CONFLICT_PATH_REGEX.test(conflicts[0]),
        `expected ${conflicts[0]} to match the conflict-path pattern`
    );
    return conflicts[0];
}

describe("File operations", () => {
    it("move to empty target just renames the file", async () => {
        const { fs, ops } = makeOps();

        await ops.create("a", new Uint8Array());
        assertSetContainsExactly(fs.names, "a");

        await ops.move("a", "b");
        assertSetContainsExactly(fs.names, "b");
    });

    it("create at an occupied path displaces the existing file to a conflict-uuid path", async () => {
        const { fs, ops } = makeOps();

        await ops.create("note.md", new Uint8Array());
        await ops.create("note.md", new Uint8Array());

        const conflict = singleConflictPath(fs.names, ["note.md"]);
        assert.ok(
            conflict.endsWith("-note.md"),
            `conflict name should preserve the original filename, got ${conflict}`
        );
    });

    it("move to an occupied target displaces the target to a conflict-uuid path", async () => {
        const { fs, ops } = makeOps();

        await ops.create("source.md", new Uint8Array());
        await ops.create("dest.md", new Uint8Array());

        await ops.move("source.md", "dest.md");

        // `dest.md` now holds what used to be at `source.md`; the original
        // `dest.md` moved to a conflict path in the same directory.
        const conflict = singleConflictPath(fs.names, ["dest.md"]);
        assert.ok(
            conflict.endsWith("-dest.md"),
            `conflict should preserve the original filename, got ${conflict}`
        );
    });

    it("preserves the parent directory when generating a conflict path", async () => {
        const { fs, ops } = makeOps();

        await ops.create("a/b.c/d", new Uint8Array());
        await ops.create("a/b.c/e", new Uint8Array());
        await ops.move("a/b.c/d", "a/b.c/e");

        const conflict = singleConflictPath(fs.names, ["a/b.c/e"]);
        assert.ok(
            conflict.startsWith("a/b.c/"),
            `conflict should live in the same directory, got ${conflict}`
        );
        assert.ok(
            conflict.endsWith("-e"),
            `conflict should preserve the filename, got ${conflict}`
        );
    });

    it("handles dotfiles without mangling the extension", async () => {
        const { fs, ops } = makeOps();

        await ops.create(".gitignore", new Uint8Array());
        await ops.create("temp", new Uint8Array());
        await ops.move("temp", ".gitignore");

        const conflict = singleConflictPath(fs.names, [".gitignore"]);
        assert.ok(
            conflict.endsWith("-.gitignore"),
            `conflict should preserve the dotfile name verbatim, got ${conflict}`
        );

        await ops.create(".config.json", new Uint8Array());
        await ops.create("temp2", new Uint8Array());
        await ops.move("temp2", ".config.json");

        // Now one conflict for .gitignore, one for .config.json.
        const conflicts = Array.from(fs.names).filter(
            (name) => name !== ".gitignore" && name !== ".config.json"
        );
        assert.equal(conflicts.length, 2);
        assert.ok(conflicts.every((c) => CONFLICT_PATH_REGEX.test(c)));
        assert.ok(conflicts.some((c) => c.endsWith("-.gitignore")));
        assert.ok(conflicts.some((c) => c.endsWith("-.config.json")));
    });

    it("generates a fresh conflict path on every displacement", async () => {
        const { fs, ops } = makeOps();

        await ops.create("x", new Uint8Array());
        await ops.create("x", new Uint8Array());
        await ops.create("x", new Uint8Array());

        const conflicts = Array.from(fs.names).filter((n) => n !== "x");
        assert.equal(conflicts.length, 2);
        assert.ok(conflicts.every((c) => CONFLICT_PATH_REGEX.test(c)));
        assert.notEqual(
            conflicts[0],
            conflicts[1],
            "each displacement should produce a unique conflict path"
        );
    });
});
