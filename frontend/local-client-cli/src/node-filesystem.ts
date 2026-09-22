import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants, type Stats } from "node:fs";
import type { FileSystemOperations, FileSnapshot } from "sync-client";

function hasCode(error: unknown, ...codes: string[]): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        codes.includes(error.code)
    );
}

export const VAULTLINK_DIR = ".vaultlink";

/** Preflights reject unsafe paths and links. This is not a sandbox against a
 * hostile process concurrently replacing ancestor directories. */
export class NodeFileSystemOperations implements FileSystemOperations {
    public constructor(private readonly root: string) {}
    public async stat(
        relative: string
    ): ReturnType<FileSystemOperations["stat"]> {
        const info = await this.info(await this.resolve(relative));
        return info
            ? {
                  kind: info.isFile()
                      ? ("file" as const)
                      : ("directory" as const),
                  size: info.size
              }
            : undefined;
    }
    public async exists(relative: string): Promise<boolean> {
        return (await this.stat(relative)) !== undefined;
    }
    public async readSnapshot(
        relative: string
    ): Promise<FileSnapshot | undefined> {
        const absolute = await this.resolve(relative);
        const handle = await fs
            .open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
            .catch((error: unknown) => {
                if (hasCode(error, "ENOENT", "ENOTDIR")) return undefined;
                throw error;
            });
        if (!handle) return undefined;
        try {
            const before = await handle.stat({ bigint: true });
            assert(
                before.isFile() && before.nlink === 1n,
                "Not an independent regular file"
            );
            const content = new Uint8Array(await handle.readFile());
            const after = await handle.stat({ bigint: true });
            const atPath = await fs.lstat(absolute, { bigint: true });
            assert(
                before.ino === after.ino &&
                    after.ino === atPath.ino &&
                    before.size === after.size &&
                    before.mtimeNs === after.mtimeNs &&
                    before.ctimeNs === after.ctimeNs,
                "File changed during read"
            );
            return { content };
        } finally {
            await handle.close();
        }
    }
    public async listFilesRecursively(root = ""): Promise<string[]> {
        const result: string[] = [];
        for (const name of await fs.readdir(await this.resolve(root))) {
            const relative = root ? `${root}/${name}` : name;
            const entry = await this.stat(relative);
            assert(entry, `File changed during scan: ${relative}`);
            if (entry.kind === "directory")
                result.push(...(await this.listFilesRecursively(relative)));
            else result.push(relative);
        }
        return result.sort();
    }
    public async createDirectory(relative: string): Promise<void> {
        await this.resolve(relative);
        let current = this.root;
        for (const component of relative.split("/").filter(Boolean)) {
            const next = path.join(current, component);
            try {
                await fs.mkdir(next);
            } catch (error) {
                if (!hasCode(error, "EEXIST")) throw error;
            }
            assert((await fs.lstat(next)).isDirectory());
            current = next;
        }
    }
    public async write(
        relative: string,
        snapshot: FileSnapshot
    ): Promise<void> {
        const destination = await this.resolve(relative);
        await this.createDirectory(
            path.posix.dirname(relative) === "."
                ? ""
                : path.posix.dirname(relative)
        );
        await fs.writeFile(destination, snapshot.content, {
            flag: "wx",
            mode: 0o600
        });
    }
    public async rename(from: string, to: string): Promise<void> {
        const snapshot = await this.readSnapshot(from);
        assert(snapshot, `Missing source: ${from}`);
        // Node's rename overwrites destinations on POSIX. Exclusive copy followed
        // by unlink leaves ordinary discoverable files if interrupted.
        await this.write(to, snapshot);
        const current = await this.readSnapshot(from);
        assert(
            current &&
                Buffer.from(current.content).equals(
                    Buffer.from(snapshot.content)
                ),
            `Source changed during move: ${from}`
        );
        await this.deleteFile(from);
    }
    public async delete(relative: string): Promise<void> {
        assert(relative, "Cannot prune root");
        const absolute = await this.resolve(relative);
        const entry = await this.info(absolute);
        if (!entry) return;
        assert(entry.isDirectory(), "Cannot delete regular file");
        for (const child of await fs.readdir(absolute))
            await this.delete(`${relative}/${child}`);
        await fs.rmdir(absolute);
    }
    public async deleteFile(relative: string): Promise<void> {
        const absolute = await this.resolve(relative);
        const entry = await this.info(absolute);
        if (!entry) return;
        assert(entry.isFile() && entry.nlink === 1, "Cannot unlink non-file");
        await fs.unlink(absolute).catch((error: unknown) => {
            if (!hasCode(error, "ENOENT")) throw error;
        });
    }
    private async resolve(relative: string): Promise<string> {
        assert(
            relative === "" ||
                relative
                    .split("/")
                    .every(
                        (p) =>
                            p !== "" &&
                            p !== "." &&
                            p !== ".." &&
                            !p.includes("\\") &&
                            !p.includes("\0") &&
                            (process.platform !== "win32" || !p.includes(":"))
                    ),
            "Unsafe path"
        );
        assert(
            (await fs.lstat(this.root)).isDirectory(),
            "Vault root must be a directory, not a symlink"
        );
        let current = this.root;
        for (const component of relative.split("/").filter(Boolean)) {
            current = path.join(current, component);
            const entry = await this.info(current);
            if (entry)
                assert(
                    entry.isDirectory() ||
                        (entry.isFile() && entry.nlink === 1),
                    "Symlink, hardlink or special file"
                );
        }
        return current;
    }
    private async info(absolute: string): Promise<Stats | undefined> {
        try {
            return await fs.lstat(absolute);
        } catch (error) {
            if (hasCode(error, "ENOENT", "ENOTDIR")) return undefined;
            throw error;
        }
    }
}
