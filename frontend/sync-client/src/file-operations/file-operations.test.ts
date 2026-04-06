import { describe, it } from "node:test";
import type { DocumentId, DocumentRecord, RelativePath } from "../sync-operations/types";
import type { SyncEventQueue } from "../sync-operations/sync-event-queue";
import { FileOperations } from "./file-operations";
import { Logger } from "../tracing/logger";
import { assertSetContainsExactly } from "../utils/assert-set-contains-exactly";
import type { FileSystemOperations } from "./filesystem-operations";
import type { TextWithCursors } from "reconcile-text";
import type { ServerConfig, ServerConfigData } from "../services/server-config";

class MockServerConfig implements Pick<ServerConfig, "getConfig"> {
    public async getConfig(): Promise<ServerConfigData> {
        return {
            mergeableFileExtensions: ["md", "txt"],
            supportedApiVersion: 1,
            isAuthenticated: true
        };
    }
}

class MockQueue implements Pick<SyncEventQueue, "getDocument" | "moveDocument"> {
    public getDocument(
        _path: RelativePath
    ): DocumentRecord | undefined {
        return undefined;
    }

    public moveDocument(
        _oldPath: RelativePath,
        _newPath: RelativePath
    ): DocumentId | undefined {
        return undefined;
    }
}

class FakeFileSystemOperations implements FileSystemOperations {
    public readonly names = new Set<string>();

    public async listFilesRecursively(
        _root: RelativePath | undefined
    ): Promise<RelativePath[]> {
        return ["file.md"];
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
    public async createDirectory(_path: RelativePath): Promise<void> {
        // this is called but irrelevant for this mock
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

describe("File operations", () => {
    it("should deconflict renames", async () => {
        const fileSystemOperations = new FakeFileSystemOperations();
        const fileOperations = new FileOperations(
            new Logger(),
            new MockQueue() as SyncEventQueue, // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
            fileSystemOperations,
            new MockServerConfig() as ServerConfig // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
        );

        await fileOperations.create("a", new Uint8Array());
        assertSetContainsExactly(fileSystemOperations.names, "a");
        await fileOperations.move("a", "b");
        assertSetContainsExactly(fileSystemOperations.names, "b");

        await fileOperations.create("c", new Uint8Array());
        assertSetContainsExactly(fileSystemOperations.names, "b", "c");

        await fileOperations.move("c", "b");
        assertSetContainsExactly(fileSystemOperations.names, "b", "b (1)");

        await fileOperations.create("c", new Uint8Array());
        await fileOperations.move("c", "b");
        assertSetContainsExactly(
            fileSystemOperations.names,
            "b",
            "b (1)",
            "b (2)"
        );
    });

    it("should deconflict renames with file extension", async () => {
        const fileSystemOperations = new FakeFileSystemOperations();
        const fileOperations = new FileOperations(
            new Logger(),
            new MockQueue() as SyncEventQueue, // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
            fileSystemOperations,
            new MockServerConfig() as ServerConfig // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
        );

        await fileOperations.create("b.md", new Uint8Array());
        await fileOperations.create("c.md", new Uint8Array());
        await fileOperations.move("c.md", "b.md");
        assertSetContainsExactly(
            fileSystemOperations.names,
            "b.md",
            "b (1).md"
        );

        await fileOperations.create("d.md", new Uint8Array());
        await fileOperations.move("d.md", "b.md");
        assertSetContainsExactly(
            fileSystemOperations.names,
            "b.md",
            "b (1).md",
            "b (2).md"
        );

        await fileOperations.create("file-23.md", new Uint8Array());
        await fileOperations.create("file-23 (1).md", new Uint8Array());
        await fileOperations.move("file-23.md", "file-23 (1).md");
        assertSetContainsExactly(
            fileSystemOperations.names,
            "b.md",
            "b (1).md",
            "b (2).md",
            "file-23 (1).md",
            "file-23 (2).md"
        );
    });

    it("should deconflict renames with paths", async () => {
        const fileSystemOperations = new FakeFileSystemOperations();
        const fileOperations = new FileOperations(
            new Logger(),
            new MockQueue() as SyncEventQueue, // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
            fileSystemOperations,
            new MockServerConfig() as ServerConfig // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
        );

        await fileOperations.create("a/b.c/d", new Uint8Array());
        await fileOperations.create("a/b.c/e", new Uint8Array());
        await fileOperations.move("a/b.c/d", "a/b.c/e");
        assertSetContainsExactly(
            fileSystemOperations.names,
            "a/b.c/e",
            "a/b.c/e (1)"
        );
    });

    it("should continue deconfliction from existing number in filename", async () => {
        const fileSystemOperations = new FakeFileSystemOperations();
        const fileOperations = new FileOperations(
            new Logger(),
            new MockQueue() as SyncEventQueue, // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
            fileSystemOperations,
            new MockServerConfig() as ServerConfig // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
        );

        await fileOperations.create("document (5).md", new Uint8Array());
        await fileOperations.create("other.md", new Uint8Array());

        await fileOperations.move("other.md", "document (5).md");
        assertSetContainsExactly(
            fileSystemOperations.names,
            "document (5).md",
            "document (6).md"
        );

        await fileOperations.create("another.md", new Uint8Array());
        await fileOperations.move("another.md", "document (5).md");
        assertSetContainsExactly(
            fileSystemOperations.names,
            "document (5).md",
            "document (6).md",
            "document (7).md"
        );
    });

    it("should handle dotfiles correctly", async () => {
        const fileSystemOperations = new FakeFileSystemOperations();
        const fileOperations = new FileOperations(
            new Logger(),
            new MockQueue() as SyncEventQueue, // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
            fileSystemOperations,
            new MockServerConfig() as ServerConfig // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
        );

        await fileOperations.create(".gitignore", new Uint8Array());
        await fileOperations.create("temp", new Uint8Array());
        await fileOperations.move("temp", ".gitignore");
        assertSetContainsExactly(
            fileSystemOperations.names,
            ".gitignore",
            ".gitignore (1)"
        );

        await fileOperations.create(".config.json", new Uint8Array());
        await fileOperations.create("temp2", new Uint8Array());
        await fileOperations.move("temp2", ".config.json");
        assertSetContainsExactly(
            fileSystemOperations.names,
            ".gitignore",
            ".gitignore (1)",
            ".config.json",
            ".config (1).json"
        );
    });
});
