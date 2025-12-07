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
        await fsOps.write("test.txt", content);

        const readContent = await fsOps.read("test.txt");
        assert.equal(new TextDecoder().decode(readContent), "Hello, world!");
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
        await fsOps.write("dir1/dir2/test.txt", content);

        const readContent = await fsOps.read("dir1/dir2/test.txt");
        assert.equal(new TextDecoder().decode(readContent), "Nested file");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - exists with forward slashes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        assert.equal(await fsOps.exists("test.txt"), false);

        await fsOps.write("test.txt", new TextEncoder().encode("test"));

        assert.equal(await fsOps.exists("test.txt"), true);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - delete with forward slashes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        await fsOps.write("test.txt", new TextEncoder().encode("test"));
        assert.equal(await fsOps.exists("test.txt"), true);

        await fsOps.delete("test.txt");
        assert.equal(await fsOps.exists("test.txt"), false);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - rename with forward slashes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        const content = new TextEncoder().encode("test content");
        await fsOps.write("old.txt", content);

        await fsOps.rename("old.txt", "new.txt");

        assert.equal(await fsOps.exists("old.txt"), false);
        assert.equal(await fsOps.exists("new.txt"), true);

        const readContent = await fsOps.read("new.txt");
        assert.equal(new TextDecoder().decode(readContent), "test content");
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - rename to nested path with forward slashes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        const content = new TextEncoder().encode("test content");
        await fsOps.write("old.txt", content);

        await fsOps.rename("old.txt", "dir1/dir2/new.txt");

        assert.equal(await fsOps.exists("old.txt"), false);
        assert.equal(await fsOps.exists("dir1/dir2/new.txt"), true);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - getFileSize", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        const content = new TextEncoder().encode("Hello!");
        await fsOps.write("test.txt", content);

        const size = await fsOps.getFileSize("test.txt");
        assert.equal(size, content.length);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test("NodeFileSystemOperations - atomicUpdateText", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultlink-test-"));
    const fsOps = new NodeFileSystemOperations(tempDir);

    try {
        await fsOps.write("test.txt", new TextEncoder().encode("Hello"));

        const result = await fsOps.atomicUpdateText("test.txt", (current) => ({
            text: current.text + " World",
            cursors: []
        }));

        assert.equal(result, "Hello World");

        const content = await fsOps.read("test.txt");
        assert.equal(new TextDecoder().decode(content), "Hello World");
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

        await fsOps.write(testPath, content);
        assert.equal(await fsOps.exists(testPath), true);

        const readContent = await fsOps.read(testPath);
        assert.equal(new TextDecoder().decode(readContent), "test");

        await fsOps.delete(testPath);
        assert.equal(await fsOps.exists(testPath), false);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
