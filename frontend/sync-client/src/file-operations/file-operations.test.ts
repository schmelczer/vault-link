import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RelativePath } from "../sync-operations/types";
import { FileOperations, MoveOnConflict } from "./file-operations";
import { Logger } from "../tracing/logger";
import { assertSetContainsExactly } from "../utils/assert-set-contains-exactly";
import type { FileSystemOperations } from "./filesystem-operations";
import type { TextWithCursors } from "reconcile-text";
import type { ServerConfig, ServerConfigData } from "../services/server-config";
import { CONFLICT_PATH_REGEX } from "../sync-operations/conflict-path";
import { removeFromArray } from "../utils/remove-from-array";
import { ExpectedFsEvents } from "../sync-operations/expected-fs-events";

class MockServerConfig implements Pick<ServerConfig, "getConfig"> {
    public async getConfig(): Promise<ServerConfigData> {
        return {
            mergeableFileExtensions: ["md", "txt"],
            supportedApiVersion: 1,
            isAuthenticated: true
        };
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
    public async exists(path: RelativePath): Promise<boolean> {
        return this.names.has(path);
    }
    public async createDirectory(_path: RelativePath): Promise<void> {
        // no-op for the in-memory fake; we only track files
    }
    public async delete(path: RelativePath): Promise<void> {
        this.names.delete(path);
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
        fs,
        new MockServerConfig() as ServerConfig, // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
        new ExpectedFsEvents()
    );
    return { fs, ops };
}

function singleConflictPath(
    names: Set<string>,
    expectedNonConflictNames: string[]
): string {
    const expected = new Set(expectedNonConflictNames);
    const conflicts = Array.from(names).filter((name) => !expected.has(name));
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

        await ops.create("a", new Uint8Array(), MoveOnConflict.EXISTING);
        assertSetContainsExactly(fs.names, "a");

        await ops.move("a", "b", MoveOnConflict.EXISTING);
        assertSetContainsExactly(fs.names, "b");
    });

    it("create with EXISTING displaces the existing file to a conflict path", async () => {
        const { fs, ops } = makeOps();

        await ops.create("note.md", new Uint8Array(), MoveOnConflict.EXISTING);
        await ops.create("note.md", new Uint8Array(), MoveOnConflict.EXISTING);

        // The original `note.md` location now holds the new file; the previous
        // contents were displaced to a conflict path.
        const conflict = singleConflictPath(fs.names, ["note.md"]);
        assert.ok(
            conflict.endsWith("-note.md"),
            `conflict name should preserve the original filename, got ${conflict}`
        );
    });

    it("create with NEW redirects the new file to a conflict path", async () => {
        const { fs, ops } = makeOps();

        await ops.create("note.md", new Uint8Array(), MoveOnConflict.EXISTING);
        await ops.create("note.md", new Uint8Array(), MoveOnConflict.NEW);

        // The original `note.md` is untouched; the new file went to a conflict path.
        const conflict = singleConflictPath(fs.names, ["note.md"]);
        assert.ok(
            conflict.endsWith("-note.md"),
            `conflict name should preserve the original filename, got ${conflict}`
        );
    });

    it("move with EXISTING displaces the target to a conflict path", async () => {
        const { fs, ops } = makeOps();

        await ops.create(
            "source.md",
            new Uint8Array(),
            MoveOnConflict.EXISTING
        );
        await ops.create("dest.md", new Uint8Array(), MoveOnConflict.EXISTING);

        await ops.move("source.md", "dest.md", MoveOnConflict.EXISTING);

        // `dest.md` now holds what used to be at `source.md`; the original
        // `dest.md` moved to a conflict path in the same directory.
        const conflict = singleConflictPath(fs.names, ["dest.md"]);
        assert.ok(
            conflict.endsWith("-dest.md"),
            `conflict should preserve the original filename, got ${conflict}`
        );
    });

    it("move with NEW redirects the moved file to a conflict path", async () => {
        const { fs, ops } = makeOps();

        await ops.create(
            "source.md",
            new Uint8Array(),
            MoveOnConflict.EXISTING
        );
        await ops.create("dest.md", new Uint8Array(), MoveOnConflict.EXISTING);

        await ops.move("source.md", "dest.md", MoveOnConflict.NEW);

        // The original `dest.md` is untouched; the moved file went to a conflict path.
        const conflict = singleConflictPath(fs.names, ["dest.md"]);
        assert.ok(
            conflict.endsWith("-dest.md"),
            `conflict should preserve the original filename, got ${conflict}`
        );
    });

    it("preserves the parent directory when generating a conflict path", async () => {
        const { fs, ops } = makeOps();

        await ops.create("a/b.c/d", new Uint8Array(), MoveOnConflict.EXISTING);
        await ops.create("a/b.c/e", new Uint8Array(), MoveOnConflict.EXISTING);
        await ops.move("a/b.c/d", "a/b.c/e", MoveOnConflict.EXISTING);

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

        await ops.create(
            ".gitignore",
            new Uint8Array(),
            MoveOnConflict.EXISTING
        );
        await ops.create("temp", new Uint8Array(), MoveOnConflict.EXISTING);
        await ops.move("temp", ".gitignore", MoveOnConflict.EXISTING);

        const conflict = singleConflictPath(fs.names, [".gitignore"]);
        assert.ok(
            conflict.endsWith("-.gitignore"),
            `conflict should preserve the dotfile name verbatim, got ${conflict}`
        );

        await ops.create(
            ".config.json",
            new Uint8Array(),
            MoveOnConflict.EXISTING
        );
        await ops.create("temp2", new Uint8Array(), MoveOnConflict.EXISTING);
        await ops.move("temp2", ".config.json", MoveOnConflict.EXISTING);

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

        await ops.create("x", new Uint8Array(), MoveOnConflict.EXISTING);
        await ops.create("x", new Uint8Array(), MoveOnConflict.EXISTING);
        await ops.create("x", new Uint8Array(), MoveOnConflict.EXISTING);

        const conflicts = Array.from(fs.names);
        removeFromArray(conflicts, "x");
        assert.equal(conflicts.length, 2);
        assert.ok(conflicts.every((c) => CONFLICT_PATH_REGEX.test(c)));
        assert.notEqual(
            conflicts[0],
            conflicts[1],
            "each displacement should produce a unique conflict path"
        );
    });
});
