import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type {
    FileSystemOperations,
    RelativePath,
    TextWithCursors
} from "sync-client";
import { toUnixPath } from "./path-utils";

// VaultLink's per-vault metadata directory. Holds the persisted sync database
// and the tmp files atomicWrite renames into place; the matching `${VAULTLINK_DIR}/**`
// ignore pattern keeps everything in here invisible to the file watcher.
export const VAULTLINK_DIR = ".vaultlink";

export class NodeFileSystemOperations implements FileSystemOperations {
    public constructor(private readonly basePath: string) {}

    public async listFilesRecursively(
        directory: RelativePath | undefined
    ): Promise<RelativePath[]> {
        const files: RelativePath[] = [];
        await this.walkDirectory(directory ?? "", files);
        return files;
    }

    public async read(relativePath: RelativePath): Promise<Uint8Array> {
        const fullPath = path.join(this.basePath, relativePath);
        try {
            return await fs.readFile(fullPath);
        } catch (error) {
            throw new Error(
                `Failed to read file ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    public async write(
        relativePath: RelativePath,
        content: Uint8Array
    ): Promise<void> {
        const fullPath = path.join(this.basePath, relativePath);
        const dir = path.dirname(fullPath);

        try {
            await fs.mkdir(dir, { recursive: true });
            await this.atomicWrite(fullPath, content);
        } catch (error) {
            throw new Error(
                `Failed to write file ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    public async atomicUpdateText(
        relativePath: RelativePath,
        updater: (current: TextWithCursors) => TextWithCursors
    ): Promise<string> {
        const fullPath = path.join(this.basePath, relativePath);

        try {
            const currentContent = await fs.readFile(fullPath, "utf-8");
            const result = updater({ text: currentContent, cursors: [] });
            await this.atomicWrite(fullPath, result.text, "utf-8");
            return result.text;
        } catch (error) {
            throw new Error(
                `Failed to atomically update file ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    public async getFileSize(relativePath: RelativePath): Promise<number> {
        const fullPath = path.join(this.basePath, relativePath);
        try {
            const stats = await fs.stat(fullPath);
            return stats.size;
        } catch (error) {
            throw new Error(
                `Failed to get file size for ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    public async exists(relativePath: RelativePath): Promise<boolean> {
        const fullPath = path.join(this.basePath, relativePath);
        try {
            await fs.access(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    public async createDirectory(relativePath: RelativePath): Promise<void> {
        const fullPath = path.join(this.basePath, relativePath);
        try {
            await fs.mkdir(fullPath, { recursive: false });
        } catch (error) {
            throw new Error(
                `Failed to create directory ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    public async delete(relativePath: RelativePath): Promise<void> {
        if (!relativePath) {
            throw new Error("Cannot delete the vault root");
        }

        const fullPath = path.join(this.basePath, relativePath);
        try {
            await this.deleteDirectoryTree(fullPath);
        } catch (error) {
            throw new Error(
                `Failed to delete directory ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    public async deleteFile(relativePath: RelativePath): Promise<void> {
        const fullPath = path.join(this.basePath, relativePath);
        try {
            const entry = await fs.lstat(fullPath).catch((error: unknown) => {
                if (this.isMissing(error)) return undefined;
                throw error;
            });
            if (!entry) return;
            if (!entry.isFile() || entry.nlink !== 1) {
                throw new Error("Cannot unlink a non-regular or linked file");
            }

            await fs.unlink(fullPath).catch((error: unknown) => {
                if (!this.isMissing(error)) throw error;
            });
            await this.syncDirectory(path.dirname(fullPath));
        } catch (error) {
            throw new Error(
                `Failed to delete file ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    public async rename(
        oldPath: RelativePath,
        newPath: RelativePath
    ): Promise<void> {
        const oldFullPath = path.join(this.basePath, oldPath);
        const newFullPath = path.join(this.basePath, newPath);
        const newDir = path.dirname(newFullPath);

        try {
            await fs.mkdir(newDir, { recursive: true });
            await fs.rename(oldFullPath, newFullPath);
        } catch (error) {
            throw new Error(
                `Failed to rename file from ${oldFullPath} to ${newFullPath}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private async atomicWrite(
        fullPath: string,
        content: Uint8Array | string,
        encoding?: BufferEncoding
    ): Promise<void> {
        const tmpDir = path.join(this.basePath, VAULTLINK_DIR);
        await fs.mkdir(tmpDir, { recursive: true });
        const tmpPath = path.join(tmpDir, `atomic-write-${randomUUID()}.tmp`);
        try {
            await fs.writeFile(tmpPath, content, encoding);
            const fd = await fs.open(tmpPath, "r");
            try {
                await fd.datasync();
            } finally {
                await fd.close();
            }
            await fs.rename(tmpPath, fullPath);
            await this.syncDirectory(path.dirname(fullPath));
        } catch (error) {
            await fs.unlink(tmpPath).catch(() => undefined);
            throw error;
        }
    }

    // Make the rename durable by fsync'ing the destination's parent directory.
    // Skipped on Windows: fsync on a directory handle isn't supported there
    private async syncDirectory(dir: string): Promise<void> {
        if (process.platform === "win32") {
            return;
        }
        const fd = await fs.open(dir, "r");
        try {
            await fd.sync();
        } finally {
            await fd.close();
        }
    }

    private async deleteDirectoryTree(fullPath: string): Promise<void> {
        const entry = await fs.lstat(fullPath).catch((error: unknown) => {
            if (this.isMissing(error)) return undefined;
            throw error;
        });
        if (!entry) return;
        if (!entry.isDirectory()) {
            throw new Error("Cannot delete a regular file as a directory");
        }

        for (const child of await fs.readdir(fullPath, {
            withFileTypes: true
        })) {
            if (!child.isDirectory()) {
                throw new Error(
                    `Directory contains a non-directory entry: ${path.join(fullPath, child.name)}`
                );
            }
            await this.deleteDirectoryTree(path.join(fullPath, child.name));
        }

        await fs.rmdir(fullPath);
        await this.syncDirectory(path.dirname(fullPath));
    }

    private isMissing(error: unknown): boolean {
        return (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
        );
    }

    private async walkDirectory(
        relativePath: string,
        files: RelativePath[]
    ): Promise<void> {
        const fullPath = path.join(this.basePath, relativePath);
        let entries: Dirent[] = [];

        try {
            entries = await fs.readdir(fullPath, { withFileTypes: true });
        } catch (error) {
            throw new Error(
                `Failed to read directory ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        for (const entry of entries) {
            const entryName = entry.name;
            const entryRelativePath = path.join(relativePath, entryName);

            if (entry.isDirectory()) {
                await this.walkDirectory(entryRelativePath, files);
            } else if (entry.isFile()) {
                // Always return forward slashes
                files.push(toUnixPath(entryRelativePath));
            }
        }
    }
}
