import type { DataAdapter } from "obsidian";
import type { FileSystemOperations, FileSnapshot } from "sync-client";

/** Mobile storage has no Node filesystem. DataAdapter.copy provides its
 * documented exclusive-create primitive; writeBinary overwrites existing files. */
export class MobileFileSystemOperations implements FileSystemOperations {
    public constructor(private readonly adapter: DataAdapter) {}

    public async stat(path: string): ReturnType<FileSystemOperations["stat"]> {
        const entry = await this.adapter.stat(this.check(path));
        return entry
            ? {
                  kind:
                      entry.type === "file"
                          ? ("file" as const)
                          : ("directory" as const),
                  size: entry.size
              }
            : undefined;
    }
    public async exists(path: string): Promise<boolean> {
        return (await this.stat(path)) !== undefined;
    }
    public async listFilesRecursively(root = ""): Promise<string[]> {
        const entries = await this.adapter.list(this.check(root));
        const files = [...entries.files];
        for (const folder of entries.folders)
            files.push(...(await this.listFilesRecursively(folder)));
        return files;
    }
    public async readSnapshot(path: string): Promise<FileSnapshot | undefined> {
        this.check(path);
        const before = await this.adapter.stat(path);
        if (!before) return undefined;
        if (before.type !== "file") throw new Error(`Not a file: ${path}`);
        const content = new Uint8Array(await this.adapter.readBinary(path));
        const after = await this.adapter.stat(path);
        if (
            !after ||
            before.size !== after.size ||
            before.mtime !== after.mtime ||
            before.ctime !== after.ctime
        )
            throw new Error(`File changed during read: ${path}`);
        return { content };
    }
    public async createDirectory(path: string): Promise<void> {
        this.check(path);
        let current = "";
        for (const part of path.split("/").filter(Boolean)) {
            current = current ? `${current}/${part}` : part;
            if (!(await this.exists(current))) {
                try {
                    await this.adapter.mkdir(current);
                } catch (error) {
                    if ((await this.stat(current))?.kind !== "directory")
                        throw error;
                }
            }
            if ((await this.stat(current))?.kind !== "directory")
                throw new Error(`Not a directory: ${current}`);
        }
    }
    public async write(path: string, snapshot: FileSnapshot): Promise<void> {
        this.check(path);
        await this.createDirectory(path.split("/").slice(0, -1).join("/"));
        await this.createDirectory(".vault-link-sync");
        const temporary = `.vault-link-sync/${crypto.randomUUID()}.tmp`;
        try {
            await this.adapter.writeBinary(
                temporary,
                new Uint8Array(snapshot.content).buffer
            );
            await this.adapter.copy(temporary, path);
        } finally {
            if (await this.adapter.exists(temporary))
                await this.adapter.remove(temporary);
        }
    }
    public async rename(from: string, to: string): Promise<void> {
        this.check(from);
        this.check(to);
        const snapshot = await this.readSnapshot(from);
        if (!snapshot) throw new Error(`Missing source: ${from}`);
        await this.write(to, snapshot);
        const current = await this.readSnapshot(from);
        if (
            !current ||
            current.content.length !== snapshot.content.length ||
            current.content.some((byte, i) => byte !== snapshot.content[i])
        )
            throw new Error(`Source changed during move: ${from}`);
        await this.deleteFile(from);
    }
    public async deleteFile(path: string): Promise<void> {
        const entry = await this.stat(path);
        if (!entry) return;
        if (entry.kind !== "file") throw new Error(`Not a file: ${path}`);
        await this.adapter.remove(path);
    }
    public async delete(path: string): Promise<void> {
        if (!path) throw new Error("Cannot prune root");
        const entry = await this.stat(path);
        if (!entry) return;
        if (entry.kind !== "directory")
            throw new Error(`Not a directory: ${path}`);
        const children = await this.adapter.list(path);
        if (children.files.length)
            throw new Error(`Directory contains files: ${path}`);
        for (const folder of children.folders) await this.delete(folder);
        await this.adapter.rmdir(path, false);
    }
    private check(path: string): string {
        if (
            path !== "" &&
            path
                .split("/")
                .some(
                    (part) =>
                        !part ||
                        part === "." ||
                        part === ".." ||
                        part.includes("\\") ||
                        part.includes("\0")
                )
        )
            throw new Error(`Unsafe path: ${path}`);
        return path;
    }
}
