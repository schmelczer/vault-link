import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RelativePath } from "../sync-operations/types";
import { FileOperations } from "./file-operations";
import { Logger } from "../tracing/logger";
import { assertSetContainsExactly } from "../utils/assert-set-contains-exactly";
import type { FileSystemOperations } from "./filesystem-operations";
import type { TextWithCursors } from "reconcile-text";
import type { ServerConfig, ServerConfigData } from "../services/server-config";
import { ExpectedFsEvents } from "../sync-operations/expected-fs-events";
import { FileAlreadyExistsError } from "../errors/file-already-exists-error";

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

describe("File operations", () => {
    it("create writes the file at the requested path", async () => {
        const { fs, ops } = makeOps();

        const result = await ops.create("a", new Uint8Array());

        assertSetContainsExactly(fs.names, "a");
        assert.equal(result, "a");
    });

    it("create throws FileAlreadyExistsError when the path is occupied", async () => {
        const { fs, ops } = makeOps();

        await ops.create("note.md", new Uint8Array());
        await assert.rejects(
            ops.create("note.md", new Uint8Array()),
            FileAlreadyExistsError
        );

        // The original file is left intact and no other entries appeared.
        assertSetContainsExactly(fs.names, "note.md");
    });

    it("move to an empty target just renames the file", async () => {
        const { fs, ops } = makeOps();

        await ops.create("a", new Uint8Array());
        assertSetContainsExactly(fs.names, "a");

        const result = await ops.move("a", "b");
        assertSetContainsExactly(fs.names, "b");
        assert.equal(result, "b");
    });

    it("move with same source and target is a no-op", async () => {
        const { fs, ops } = makeOps();

        await ops.create("a", new Uint8Array());
        const result = await ops.move("a", "a");

        assertSetContainsExactly(fs.names, "a");
        assert.equal(result, "a");
    });

    it("move throws FileAlreadyExistsError when the target is occupied", async () => {
        const { fs, ops } = makeOps();

        await ops.create("source.md", new Uint8Array());
        await ops.create("dest.md", new Uint8Array());

        await assert.rejects(
            ops.move("source.md", "dest.md"),
            FileAlreadyExistsError
        );

        // Both files are left intact — no displacement happens.
        assertSetContainsExactly(fs.names, "source.md", "dest.md");
    });

    it("create works for nested paths (parent-directory creation)", async () => {
        const { fs, ops } = makeOps();

        await ops.create("a/b.c/d", new Uint8Array());
        assertSetContainsExactly(fs.names, "a/b.c/d");
    });

    it("move works for nested target paths (parent-directory creation)", async () => {
        const { fs, ops } = makeOps();

        await ops.create("source", new Uint8Array());
        await ops.move("source", "a/b.c/dest");

        assertSetContainsExactly(fs.names, "a/b.c/dest");
    });
});
