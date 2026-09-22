import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { Logger, SyncClient } from "sync-client";
import { ServerControl } from "../deterministic-tests/src/server-control";
import { ClientPersistence } from "../local-client-cli/src/client-persistence";
import { NodeFileSystemOperations } from "../local-client-cli/src/node-filesystem";
import { ObsidianFileSystemOperations } from "../obsidian-plugin/src/obsidian-file-system";
import { getJson, type CanonicalSnapshot } from "./canonical";

const root = path.resolve(__dirname, "../..");
const token = "test-token-change-me";
const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
async function until(check: () => Promise<boolean>, message: string) {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
        assert(Date.now() < deadline, message);
        await pause();
    }
}
async function contents(file: string) {
    try {
        return await fs.readFile(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function stop(child: ChildProcess, signal: NodeJS.Signals) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill(signal);
    await exited;
}

test(
    "production CLI watchers, Obsidian adapter, and full metadata survive process replacement",
    { timeout: 90_000 },
    async (t) => {
        const directory = await fs.mkdtemp(
            path.join(tmpdir(), "vaultlink-production-")
        );
        const server = new ServerControl(
            path.join(root, "sync-server/target/release/sync_server"),
            path.join(root, "sync-server/config-e2e.yml"),
            new Logger()
        );
        const children: ChildProcess[] = [];
        let obsidian: SyncClient | undefined;
        t.after(async () => {
            await obsidian?.destroy();
            await Promise.all(children.map((child) => stop(child, "SIGKILL")));
            await server.stop();
            await fs.rm(directory, { recursive: true, force: true });
        });
        await server.start();
        const a = path.join(directory, "a"),
            b = path.join(directory, "b"),
            c = path.join(directory, "obsidian");
        await Promise.all([a, b, c].map((p) => fs.mkdir(p)));
        await fs.writeFile(path.join(a, "note.md"), "initial\n");
        async function launch(vault: string) {
            const child = spawn(
                process.execPath,
                [
                    path.join(root, "frontend/local-client-cli/dist/cli.js"),
                    "-l",
                    vault,
                    "-r",
                    server.remoteUri,
                    "-t",
                    token,
                    "-v",
                    "production",
                    "--ignore-pattern",
                    "**/*.tmp"
                ],
                { stdio: ["ignore", "pipe", "pipe"] }
            );
            children.push(child);
            let log = "";
            child.stdout!.on("data", (data: Buffer) => {
                log += data.toString();
            });
            child.stderr!.on("data", (data: Buffer) => {
                log += data.toString();
            });
            await until(async () => {
                assert(
                    child.exitCode === null && child.signalCode === null,
                    `CLI exited: ${log}`
                );
                return log.includes("File watcher started");
            }, `CLI did not start: ${log}`);
            return child;
        }
        let first = await launch(a);
        await launch(b);
        await until(
            async () =>
                (await contents(path.join(b, "note.md"))) === "initial\n",
            "CLI initial download failed"
        );
        const persistence = (vault: string) =>
            new ClientPersistence(
                path.join(vault, ".vaultlink/sync-data.json"),
                {}
            );
        const original = (await persistence(a).load()).database!;
        const [documentId] = Object.keys(original.local!);
        assert(documentId);

        const settings = {
            remoteUri: server.remoteUri,
            token,
            vaultName: "production",
            isSyncEnabled: true,
            enableTelemetry: false,
            ignorePatterns: [".vaultlink/**"],
            syncIntervalMs: 0
        };
        obsidian = await SyncClient.create({
            fs: new ObsidianFileSystemOperations(
                new NodeFileSystemOperations(c),
                () => undefined
            ),
            persistence: new ClientPersistence(
                path.join(c, ".vaultlink/sync-data.json"),
                settings
            )
        });
        await obsidian.start();
        await obsidian.waitUntilFinished();
        assert.equal(await contents(path.join(c, "note.md")), "initial\n");
        await fs.writeFile(
            path.join(a, "replacement.tmp"),
            "atomic editor save\n"
        );
        await fs.rename(
            path.join(a, "replacement.tmp"),
            path.join(a, "note.md")
        );
        await until(
            async () =>
                (await contents(path.join(b, "note.md"))) ===
                    "atomic editor save\n" &&
                (await contents(path.join(c, "note.md"))) ===
                    "atomic editor save\n",
            "Editor replacement did not converge"
        );
        assert.equal(
            (await persistence(a).load()).database!.local![documentId],
            "note.md"
        );
        await fs.rename(path.join(b, "note.md"), path.join(b, "renamed.md"));
        await until(
            async () =>
                (await contents(path.join(a, "renamed.md"))) ===
                    "atomic editor save\n" &&
                (await contents(path.join(a, "note.md"))) === undefined,
            "CLI rename did not converge"
        );
        await until(
            async () =>
                (await persistence(a).load()).database!.local![documentId] ===
                "renamed.md",
            "Rename changed document identity"
        );
        const saved = await persistence(a).load();
        assert(
            saved.historyCheckpoint?.checkpoint,
            "CLI dropped the history checkpoint"
        );
        await stop(first, "SIGKILL");
        await fs.writeFile(path.join(a, "renamed.md"), "edited after kill\n");
        first = await launch(a);
        await until(
            async () =>
                (await contents(path.join(b, "renamed.md"))) ===
                    "edited after kill\n" &&
                (await contents(path.join(c, "renamed.md"))) ===
                    "edited after kill\n",
            "Restart failed to reconcile current files"
        );
        const snapshot = await getJson<CanonicalSnapshot>(
            `${server.remoteUri}/vaults/production/vault-snapshot`,
            token
        );
        assert.deepEqual(snapshot.fileManifest.entries, {
            [documentId]: "renamed.md"
        });
        await fs.unlink(path.join(b, "renamed.md"));
        await until(
            async () =>
                (await contents(path.join(a, "renamed.md"))) === undefined &&
                (await contents(path.join(c, "renamed.md"))) === undefined,
            "Delete did not converge"
        );
        await stop(first, "SIGTERM");
        assert.equal(first.exitCode, 0, "CLI shutdown failed");
    }
);
