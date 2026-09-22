import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { NodeFileSystemOperations } from "./node-filesystem";

test("NodeFileSystemOperations - read and write files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        const content = new TextEncoder().encode("Hello, world!");
        await fsOps.write("test.txt", { content });

        const readContent = await fsOps.readSnapshot("test.txt");
        assert.equal(
            new TextDecoder().decode(readContent!.content),
            "Hello, world!"
        );
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - create nested directories with forward slashes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        const content = new TextEncoder().encode("Nested file");
        // Always use forward slashes in API
        await fsOps.write("dir1/dir2/test.txt", { content });

        const readContent = await fsOps.readSnapshot("dir1/dir2/test.txt");
        assert.equal(
            new TextDecoder().decode(readContent!.content),
            "Nested file"
        );
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - exists with forward slashes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        assert.equal(await fsOps.exists("test.txt"), false);

        await fsOps.write("test.txt", {
            content: new TextEncoder().encode("test")
        });

        assert.equal(await fsOps.exists("test.txt"), true);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - deleteFile with forward slashes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        await fsOps.write("test.txt", {
            content: new TextEncoder().encode("test")
        });
        assert.equal(await fsOps.exists("test.txt"), true);

        await fsOps.deleteFile("test.txt");
        assert.equal(await fsOps.exists("test.txt"), false);

        await fsOps.deleteFile("test.txt");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - rename with forward slashes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        const content = new TextEncoder().encode("test content");
        await fsOps.write("old.txt", { content });

        await fsOps.rename("old.txt", "new.txt");

        assert.equal(await fsOps.exists("old.txt"), false);
        assert.equal(await fsOps.exists("new.txt"), true);

        const readContent = await fsOps.readSnapshot("new.txt");
        assert.equal(
            new TextDecoder().decode(readContent!.content),
            "test content"
        );
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - rename to nested path with forward slashes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        const content = new TextEncoder().encode("test content");
        await fsOps.write("old.txt", { content });

        await fsOps.rename("old.txt", "dir1/dir2/new.txt");

        assert.equal(await fsOps.exists("old.txt"), false);
        assert.equal(await fsOps.exists("dir1/dir2/new.txt"), true);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - stat", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        const content = new TextEncoder().encode("Hello!");
        await fsOps.write("test.txt", { content });

        const size = (await fsOps.stat("test.txt"))!.size;
        assert.equal(size, content.length);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - handles paths with forward slashes on all platforms", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        // API should always accept forward slashes
        const testPath = "deep/nested/directory/file.txt";
        const content = new TextEncoder().encode("test");

        await fsOps.write(testPath, { content });
        assert.equal(await fsOps.exists(testPath), true);

        const readContent = await fsOps.readSnapshot(testPath);
        assert.equal(new TextDecoder().decode(readContent!.content), "test");

        await fsOps.deleteFile(testPath);
        assert.equal(await fsOps.exists(testPath), false);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - delete prunes empty directory trees", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        await fs.mkdir(path.join(tempDir, "parent", "child"), {
            recursive: true
        });

        await fsOps.delete("parent");
        assert.equal(await fsOps.exists("parent"), false);

        await fsOps.delete("parent");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - delete does not remove files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        await fsOps.write("parent/file.txt", {
            content: new TextEncoder().encode("preserve me")
        });

        await assert.rejects(async () => fsOps.delete("parent"));
        assert.equal(await fsOps.exists("parent/file.txt"), true);
        await assert.rejects(async () => fsOps.delete("parent/file.txt"));
        assert.equal(await fsOps.exists("parent/file.txt"), true);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
