import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { FileSystemOperations, FileSnapshot } from "sync-client";

const exec = promisify(execFile);
/** Small integration fixture, NOT a supported application adapter. Safety
 * preflights detect static symlinks/hardlinks; they are not an openat sandbox
 * against a hostile process replacing ancestors concurrently. */
export class RealDisk implements FileSystemOperations {
    public constructor(
        private readonly root: string,
        private readonly helper: string
    ) {}
    private async resolve(relative: string): Promise<string> {
        assert(
            relative === "" ||
                relative
                    .split("/")
                    .every(
                        (p) => p && p !== "." && p !== ".." && !p.includes("\\")
                    ),
            "Unsafe path"
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
    private async info(absolute: string) {
        try {
            return await fs.lstat(absolute);
        } catch (error) {
            if (
                ["ENOENT", "ENOTDIR"].includes(
                    (error as NodeJS.ErrnoException).code ?? ""
                )
            )
                return undefined;
            throw error;
        }
    }
    private async flush(absolute: string): Promise<void> {
        const handle = await fs.open(
            absolute,
            constants.O_RDONLY | constants.O_NOFOLLOW
        );
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
    public async stat(relative: string) {
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
    public async exists(relative: string) {
        return (await this.stat(relative)) !== undefined;
    }
    public async readSnapshot(
        relative: string
    ): Promise<FileSnapshot | undefined> {
        const absolute = await this.resolve(relative);
        let handle;
        try {
            handle = await fs.open(
                absolute,
                constants.O_RDONLY | constants.O_NOFOLLOW
            );
        } catch (error) {
            if (
                ["ENOENT", "ENOTDIR"].includes(
                    (error as NodeJS.ErrnoException).code ?? ""
                )
            )
                return undefined;
            throw error;
        }
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
            if ((await this.stat(relative))!.kind === "directory")
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
                if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                    throw error;
            }
            assert((await fs.lstat(next)).isDirectory());
            await this.flush(next);
            await this.flush(current);
            current = next;
        }
    }
    public async write(
        relative: string,
        snapshot: FileSnapshot
    ): Promise<void> {
        assert(
            !snapshot.cursors?.length,
            "This disk-only fixture has no editor selections"
        );
        const destination = await this.resolve(relative);
        const staging = ".vault-link-sync/adapter-staging";
        await this.createDirectory(staging);
        const source = path.join(this.root, staging, randomUUID());
        const handle = await fs.open(source, "wx", 0o600);
        try {
            await handle.writeFile(snapshot.content);
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await exec(this.helper, ["rename", source, destination]);
            await this.flush(path.dirname(source));
            await this.flush(path.dirname(destination));
        } finally {
            await fs.unlink(source).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
            });
        }
    }
    public async rename(from: string, to: string): Promise<void> {
        const source = await this.resolve(from),
            destination = await this.resolve(to);
        assert((await this.info(source))?.isFile());
        await this.flush(source);
        await exec(this.helper, ["rename", source, destination]);
        await this.flush(path.dirname(source));
        await this.flush(path.dirname(destination));
    }
    public async flushPaths(paths: readonly string[]): Promise<void> {
        for (const relative of paths) {
            let absolute = await this.resolve(relative);
            for (;;) {
                if (await this.info(absolute)) await this.flush(absolute);
                if (absolute === this.root) break;
                absolute = path.dirname(absolute);
            }
        }
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
        await this.flush(path.dirname(absolute));
    }
    public async deleteFile(relative: string): Promise<void> {
        const absolute = await this.resolve(relative);
        const entry = await this.info(absolute);
        if (!entry) return;
        assert(entry.isFile() && entry.nlink === 1, "Cannot unlink non-file");
        await fs.unlink(absolute);
        await this.flush(path.dirname(absolute));
    }
}
