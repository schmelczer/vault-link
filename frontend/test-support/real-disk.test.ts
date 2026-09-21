import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RealDisk } from "./real-disk";
import { Database, emptyState } from "../sync-client/src/persistence/database";
import { FileOperations } from "../sync-client/src/file-operations/file-operations";
import { Logger } from "../sync-client/src/tracing/logger";
import type { ServerConfig } from "../sync-client/src/services/server-config";
import { toStoredSnapshot } from "../sync-client/src/sync-operations/content";

test(
    "real filesystem: exclusive operations, unsafe entries, and journal swaps",
    { timeout: 20_000 },
    async () => {
        const directory = await fs.mkdtemp(
            path.join(tmpdir(), "vault-link-real-fs-")
        );
        try {
            const root = path.join(directory, "vault");
            await fs.mkdir(root);
            const helper = path.join(directory, "native-fs");
            await promisify(execFile)("cc", [
                "-Wall",
                "-Wextra",
                "-O2",
                path.join(__dirname, "native-fs.c"),
                "-o",
                helper
            ]);
            const disk = new RealDisk(root, helper);
            const snapshot = (text: string) => ({
                content: new TextEncoder().encode(text)
            });
            const writes = await Promise.allSettled([
                disk.write("raced.bin", snapshot("first")),
                disk.write("raced.bin", snapshot("second"))
            ]);
            assert.equal(
                writes.filter((result) => result.status === "fulfilled").length,
                1,
                "Exclusive create overwrote a racing writer"
            );
            assert(
                ["first", "second"].includes(
                    Buffer.from(
                        (await disk.readSnapshot("raced.bin"))!.content
                    ).toString()
                )
            );
            await disk.write("a.md", snapshot("A"));
            await disk.write("b.md", snapshot("B"));
            // Recovery must flush the old source's ancestors even if another
            // writer has replaced one of those directories with a file.
            assert.equal(await disk.stat("a.md/absent.md"), undefined);
            assert.equal(await disk.readSnapshot("a.md/absent.md"), undefined);
            await disk.flushPaths(["a.md/absent.md"]);
            await assert.rejects(disk.rename("a.md", "b.md"));
            await assert.rejects(disk.delete("a.md"), /regular file/);
            await fs.symlink("a.md", path.join(root, "symlink"));
            await assert.rejects(disk.readSnapshot("symlink"), /Symlink/);
            await fs.unlink(path.join(root, "symlink"));
            await fs.link(path.join(root, "a.md"), path.join(root, "hardlink"));
            await assert.rejects(disk.readSnapshot("a.md"), /hardlink/);
            await fs.unlink(path.join(root, "hardlink"));
            // The host may be case/normalization insensitive. Whichever model
            // it exposes, an alias must never silently overwrite existing bytes.
            for (const [original, alias] of [
                ["Case.bin", "case.bin"],
                ["é.bin", "e\u0301.bin"]
            ]) {
                await disk.write(original, snapshot("original bytes"));
                if (await disk.exists(alias))
                    await assert.rejects(
                        disk.write(alias, snapshot("alias bytes"))
                    );
                else {
                    await disk.write(alias, snapshot("alias bytes"));
                    assert.equal(
                        Buffer.from(
                            (await disk.readSnapshot(alias))!.content
                        ).toString(),
                        "alias bytes"
                    );
                }
                assert.equal(
                    Buffer.from(
                        (await disk.readSnapshot(original))!.content
                    ).toString(),
                    "original bytes"
                );
            }
            const initial = emptyState("real");
            initial.local = { a: "a.md", b: "b.md" };
            for (const [id, relative] of Object.entries(initial.local))
                initial.documents[id] = {
                    materialized: true,
                    observedHash: (
                        await toStoredSnapshot(
                            (await disk.readSnapshot(relative))!
                        )
                    ).hash
                };
            const database = new Database(
                new Logger(),
                initial,
                async () => {},
                "real",
                async () => initial
            );
            const operations = new FileOperations(disk, database, {
                getConfig: async () => ({ mergeableFileExtensions: ["md"] })
            } as ServerConfig);
            const next = structuredClone(initial);
            next.local = { a: "b.md", b: "a.md" };
            await operations.apply(next);
            assert.equal(
                Buffer.from(
                    (await disk.readSnapshot("a.md"))!.content
                ).toString(),
                "B"
            );
            assert.equal(
                Buffer.from(
                    (await disk.readSnapshot("b.md"))!.content
                ).toString(),
                "A"
            );
            assert.equal(database.state.application, undefined);
        } finally {
            await fs.rm(directory, { recursive: true });
        }
    }
);
