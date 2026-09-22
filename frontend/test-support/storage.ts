import assert from "node:assert/strict";
import type {
    FileSnapshot,
    FileSystemOperations,
    StoredDatabase
} from "sync-client";

import type { StoredClient } from "sync-client";
export type { StoredClient } from "sync-client";
export type Boundary = (label: string) => void | Promise<void>;
type Entry = FileSnapshot | null; // null is a directory; absence is not a directory.
export interface DiskImage {
    visible: [string, Entry][];
    durable: [string, Entry][];
}
const parent = (path: string) => path.split("/").slice(0, -1).join("/");
export const isInternal = (path: string) =>
    path.normalize("NFC").toUpperCase().split("/")[0] === ".VAULT-LINK-SYNC";

/** The adapter and the editor are deliberately separate APIs. Engine writes do
 * not generate editor notifications. All returned snapshots are owned copies.
 *
 * This models atomic namespace operations, not a particular filesystem's
 * journal. At a visible boundary a power loss may roll back the operation;
 * a process death alone does not roll back the kernel's dirty state.
 */
export class MemoryDisk implements FileSystemOperations {
    private visible = new Map<string, Entry>([["", null]]);
    private durable = new Map<string, Entry>([["", null]]);
    private generation = 0;
    public boundary: Boundary = () => {};

    public image(): DiskImage {
        return structuredClone({
            visible: [...this.visible],
            durable: [...this.durable]
        });
    }

    public restore(image: DiskImage): void {
        this.visible = new Map(structuredClone(image.visible));
        this.durable = new Map(structuredClone(image.durable));
    }

    public crash(powerLoss = false): void {
        this.generation++;
        if (powerLoss) this.visible = structuredClone(this.durable);
    }

    /** Fence an abandoned runtime, including calls it makes after a restart. */
    public session(): FileSystemOperations {
        const generation = this.generation;
        return new Proxy(this, {
            get: (target, key) => {
                const value = Reflect.get(target, key);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                    assert.equal(
                        this.generation,
                        generation,
                        "Access from crashed filesystem session"
                    );
                    return value.apply(target, args);
                };
            }
        });
    }

    private check(path: string): void {
        assert(
            !path.startsWith("/") &&
                !path.includes("\\") &&
                !path.includes("\0"),
            `Unsafe path: ${path}`
        );
        assert(
            path === "" ||
                path
                    .split("/")
                    .every(
                        (part) => part !== "" && part !== "." && part !== ".."
                    ),
            `Unsafe path: ${path}`
        );
        for (let ancestor = parent(path); ancestor; ancestor = parent(ancestor))
            assert(
                !this.visible.has(ancestor) ||
                    this.visible.get(ancestor) === null,
                `File ancestor: ${ancestor}`
            );
    }

    private async change(
        label: string,
        paths: string[],
        mutate: () => void
    ): Promise<void> {
        const generation = this.generation;
        await this.boundary(`before:${label}`);
        assert.equal(
            this.generation,
            generation,
            "Mutation resumed after crash"
        );
        mutate();
        await this.boundary(`visible:${label}`);
        assert.equal(this.generation, generation, "Flush resumed after crash");
        for (const path of paths) {
            if (this.visible.has(path))
                this.durable.set(
                    path,
                    structuredClone(this.visible.get(path)!)
                );
            else this.durable.delete(path);
        }
        await this.boundary(`durable:${label}`);
        assert.equal(
            this.generation,
            generation,
            "Operation returned after crash"
        );
    }

    public async stat(path: string) {
        this.check(path);
        await this.boundary(`read:stat:${path}`);
        const entry = this.visible.get(path);
        return entry === undefined
            ? undefined
            : entry === null
              ? { kind: "directory" as const, size: 0 }
              : { kind: "file" as const, size: entry.content.length };
    }

    public async exists(path: string): Promise<boolean> {
        return (await this.stat(path)) !== undefined;
    }

    public async readSnapshot(path: string): Promise<FileSnapshot | undefined> {
        this.check(path);
        await this.boundary(`read:snapshot:${path}`);
        const entry = this.visible.get(path);
        assert(entry !== null, `Cannot read directory: ${path}`);
        return structuredClone(entry);
    }

    public async listFilesRecursively(root = ""): Promise<string[]> {
        this.check(root);
        await this.boundary(`read:list:${root}`);
        assert.equal(
            this.visible.get(root),
            null,
            `Cannot list non-directory: ${root}`
        );
        return [...this.visible]
            .filter(
                ([p, entry]) =>
                    entry !== null && (!root || p.startsWith(`${root}/`))
            )
            .map(([p]) => p)
            .sort();
    }

    public userFiles(): Map<string, Uint8Array> {
        return new Map(
            [...this.visible]
                .filter(([p, e]) => e !== null && !isInternal(p))
                .map(([p, e]) => [p, e!.content.slice()])
        );
    }

    public async createDirectory(path: string): Promise<void> {
        this.check(path);
        const paths: string[] = [];
        for (let p = path; p; p = parent(p)) paths.unshift(p);
        await this.change(`mkdir:${path}`, paths, () => {
            for (const p of paths)
                assert(
                    !this.visible.has(p) || this.visible.get(p) === null,
                    `File blocks directory: ${p}`
                );
            for (const p of paths) this.visible.set(p, null);
        });
    }

    public async write(path: string, snapshot: FileSnapshot): Promise<void> {
        this.check(path);
        await this.change(`write:${path}`, [path], () => {
            assert(!this.visible.has(path), `Destination exists: ${path}`);
            assert.equal(
                this.visible.get(parent(path)),
                null,
                `Parent missing: ${path}`
            );
            this.visible.set(path, structuredClone(snapshot));
        });
    }

    public async rename(from: string, to: string): Promise<void> {
        this.check(from);
        this.check(to);
        await this.change(`rename:${from}->${to}`, [from, to], () => {
            const source = this.visible.get(from);
            assert(source, `Source is not a regular file: ${from}`);
            assert(!this.visible.has(to), `Destination exists: ${to}`);
            assert.equal(
                this.visible.get(parent(to)),
                null,
                `Parent missing: ${to}`
            );
            this.visible.set(to, source);
            this.visible.delete(from);
        });
    }

    public async delete(path: string): Promise<void> {
        this.check(path);
        assert(path !== "", "Cannot remove vault root");
        const visiblePaths = [...this.visible.keys()].filter(
            (p) => p === path || p.startsWith(`${path}/`)
        );
        // A durable rmdir removes access to the whole subtree. A child whose
        // unlink was visible but unflushed cannot reappear beneath a durably
        // removed directory when this flat namespace is restored.
        const paths = [
            ...new Set([
                ...visiblePaths,
                ...[...this.durable.keys()].filter(
                    (p) => p === path || p.startsWith(`${path}/`)
                )
            ])
        ];
        await this.change(`rmdir:${path}`, paths, () => {
            for (const p of visiblePaths)
                assert.equal(
                    this.visible.get(p),
                    null,
                    `Cannot unlink regular file: ${p}`
                );
            for (const p of visiblePaths) this.visible.delete(p);
        });
    }

    public async deleteFile(path: string): Promise<void> {
        this.check(path);
        await this.change(`unlink:${path}`, [path], () => {
            const entry = this.visible.get(path);
            assert(entry !== null, `Cannot unlink directory: ${path}`);
            this.visible.delete(path);
        });
    }

    /** External editor mutations are durable by default and may replace files. */
    public async userWrite(path: string, content: Uint8Array): Promise<void> {
        this.check(path);
        await this.createDirectory(parent(path));
        assert(
            this.visible.get(path) !== null,
            `Cannot overwrite directory: ${path}`
        );
        this.visible.set(path, { content: content.slice() });
        this.durable.set(path, { content: content.slice() });
    }

    public async userDelete(path: string): Promise<void> {
        this.check(path);
        assert(this.visible.get(path), `Cannot delete missing file: ${path}`);
        this.visible.delete(path);
        this.durable.delete(path);
    }

    public async userRename(from: string, to: string): Promise<void> {
        this.check(from);
        this.check(to);
        await this.createDirectory(parent(to));
        const source = this.visible.get(from);
        assert(source, `Source is not a regular file: ${from}`);
        assert(
            this.visible.get(to) !== null,
            `Cannot overwrite directory: ${to}`
        );
        // Editors may explicitly replace a destination. This is NOT the
        // engine's rename API, which must never overwrite it.
        this.visible.delete(from);
        this.durable.delete(from);
        this.visible.set(to, structuredClone(source));
        this.durable.set(to, structuredClone(source));
    }
}

/** Atomic replacement with both definite failure and uncertain success. */
export class MemoryPersistence {
    private durable: StoredClient;
    public boundary: Boundary = () => {};
    public constructor(initial: StoredClient = {}) {
        this.durable = structuredClone(initial);
    }
    public async load(): Promise<StoredClient> {
        return structuredClone(this.durable);
    }
    public snapshot(): StoredClient {
        return structuredClone(this.durable);
    }
    public async save(next: StoredClient): Promise<void> {
        const owned = structuredClone(next);
        await this.boundary("before:save");
        this.durable = owned;
        await this.boundary("durable:save");
    }
}
