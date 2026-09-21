import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ServerControl } from "../deterministic-tests/src/server-control";
import { Logger } from "sync-client";
import { SyncClient } from "../sync-client/src/sync-client";
import { MemoryDisk, MemoryPersistence } from "./storage";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
const root = resolve(__dirname, "../..");
const token = "test-token-change-me";
const bytes = (s: string) => new TextEncoder().encode(s);
const headers = {
    Authorization: `Bearer ${token}`,
    "Device-Id": "audit",
    "Content-Type": "application/json"
};
async function put(url: string, body: unknown) {
    const r = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(body)
    });
    assert(r.ok, await r.clone().text());
    return r.json();
}
const content = (s: string) => ({
    requestId: randomUUID(),
    parentVersionId: null,
    content: { type: "Snapshot", value: Buffer.from(s).toString("base64") }
});

test(
    "connection admission rejects excess clients and releases disconnected slots",
    { timeout: 15000 },
    async () => {
        const dir = await mkdtemp(join(tmpdir(), "vault-link-admission-"));
        const config = join(dir, "config.yml");
        await writeFile(
            config,
            (
                await readFile(root + "/sync-server/config-e2e.yml", "utf8")
            ).replace("max_clients_per_vault: 256", "max_clients_per_vault: 1")
        );
        const server = new ServerControl(
            root + "/sync-server/target/release/sync_server",
            config,
            new Logger()
        );
        const sockets: WebSocket[] = [];
        try {
            await server.start();
            const url = server.remoteUri + "/vaults/" + randomUUID();
            await put(url + "/documents/" + randomUUID(), content("event"));
            const connect = async () => {
                const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
                sockets.push(ws);
                const accepted = await new Promise<boolean>((resolve) => {
                    ws.onopen = () =>
                        ws.send(
                            JSON.stringify({
                                type: "handshake",
                                token,
                                deviceId: randomUUID(),
                                lastSeenVaultUpdateId: 0
                            })
                        );
                    ws.onmessage = () => resolve(true);
                    ws.onerror = () => resolve(false);
                    ws.onclose = () => resolve(false);
                });
                return { ws, accepted };
            };
            const first = await connect();
            assert(first.accepted);
            assert.equal((await connect()).accepted, false);
            await new Promise<void>((resolve) => {
                first.ws.onclose = () => resolve();
                first.ws.close();
            });
            // A completed close releases the server's owned connection permit.
            assert.equal((await connect()).accepted, true);
        } finally {
            for (const ws of sockets) ws.close();
            await server.stop();
            await rm(dir, { recursive: true, force: true });
        }
    }
);

test(
    "an unauthenticated upgraded socket expires without a handshake",
    { timeout: 10000 },
    async () => {
        const server = new ServerControl(
            root + "/sync-server/target/release/sync_server",
            root + "/sync-server/config-e2e.yml",
            new Logger()
        );
        let ws: WebSocket | undefined;
        try {
            await server.start();
            ws = new WebSocket(
                server.remoteUri.replace("http:", "ws:") +
                    "/vaults/" +
                    randomUUID() +
                    "/ws"
            );
            const socket = ws;
            const closed = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => resolve(false), 6500);
                socket.onclose = () => {
                    clearTimeout(timer);
                    resolve(true);
                };
                socket.onerror = () => {};
            });
            assert(closed, "handshake deadline must release idle sockets");
        } finally {
            ws?.close();
            await server.stop();
        }
    }
);

test(
    "bootstrap notifications adopt the existing remote document identity",
    { timeout: 15000 },
    async () => {
        const server = new ServerControl(
            root + "/sync-server/target/release/sync_server",
            root + "/sync-server/config-e2e.yml",
            new Logger()
        );
        let client: SyncClient | undefined;
        try {
            await server.start();
            const vault = randomUUID(),
                id = randomUUID();
            const url = server.remoteUri + "/vaults/" + vault;
            await put(url + "/documents/" + id, content("REMOTE"));
            await put(url + "/file-manifest", {
                requestId: randomUUID(),
                parentFileManifestId: 0,
                entries: { [id]: "a.md" }
            });
            const disk = new MemoryDisk();
            const store = new MemoryPersistence({
                settings: {
                    remoteUri: server.remoteUri,
                    vaultName: vault,
                    token,
                    isSyncEnabled: true,
                    syncIntervalMs: 0
                }
            });
            client = await SyncClient.create({ fs: disk, persistence: store });
            await disk.userWrite("a.md", bytes("LOCAL"));
            await client.syncLocallyCreatedFile("a.md");
            await disk.userWrite("b.md", bytes("B"));
            await client.syncLocallyCreatedFile("b.md");
            await client.start();
            const files = [...disk.userFiles().keys()];
            assert.equal(files.length, 2);
        } finally {
            await client?.destroy();
            await server.stop();
        }
    }
);

test(
    "local undo survives a lost accepted reply followed by a rejected retry",
    { timeout: 15000 },
    async () => {
        const server = new ServerControl(
            root + "/sync-server/target/release/sync_server",
            root + "/sync-server/config-e2e.yml",
            new Logger()
        );
        let client: SyncClient | undefined;
        class SilentWebSocket {
            static OPEN = 1;
            readyState = 1;
            onopen: ((event: object) => void) | null = null;
            onclose:
                | ((event: { code: number; reason: string }) => void)
                | null = null;
            onmessage: ((event: { data: string }) => void) | null = null;
            onerror: ((event: object) => void) | null = null;
            constructor(_url: string | URL) {
                queueMicrotask(() => this.onopen?.({}));
            }
            send(_data: string) {}
            close() {
                this.readyState = 3;
                this.onclose?.({ code: 1000, reason: "" });
            }
        }
        try {
            await server.start();
            const vault = randomUUID(),
                id = randomUUID();
            const url = server.remoteUri + "/vaults/" + vault;
            await put(url + "/documents/" + id, content("base"));
            await put(url + "/file-manifest", {
                requestId: randomUUID(),
                parentFileManifestId: 0,
                entries: { [id]: "a.md" }
            });
            const disk = new MemoryDisk();
            const store = new MemoryPersistence({
                settings: {
                    remoteUri: server.remoteUri,
                    vaultName: vault,
                    token,
                    isSyncEnabled: true,
                    syncIntervalMs: 0,
                    networkRetryIntervalMs: 0
                }
            });
            let mode: "normal" | "lose-reply" | "reject-retry" = "normal";
            let lostId: string | undefined;
            client = await SyncClient.create({
                fs: disk,
                persistence: store,
                webSocket: SilentWebSocket as unknown as typeof WebSocket,
                fetch: async (input, init) => {
                    if (init?.method === "PUT" && mode === "reject-retry") {
                        assert.equal(
                            JSON.parse(String(init.body)).requestId,
                            lostId
                        );
                        mode = "normal";
                        return new Response("proxy body limit changed", {
                            status: 413
                        });
                    }
                    const response = await fetch(input, init);
                    if (init?.method === "PUT" && mode === "lose-reply") {
                        assert.equal(
                            (await response.clone().json()).type,
                            "Accepted"
                        );
                        lostId = JSON.parse(String(init.body)).requestId;
                        mode = "normal";
                        throw new Error("injected lost accepted response");
                    }
                    return response;
                }
            });
            await client.start();
            mode = "lose-reply";
            await disk.userWrite("a.md", bytes("base A"));
            await client.syncLocallyUpdatedFile({ relativePath: "a.md" });
            await assert.rejects(client.waitUntilFinished(), /lost accepted/);
            const original = await (
                await fetch(url + "/documents/" + id, { headers })
            ).json();
            await put(url + "/documents/" + id, {
                ...content("base A REMOTE"),
                parentVersionId: original.vaultUpdateId
            });
            mode = "reject-retry";
            await disk.userWrite("a.md", bytes("base"));
            await client.syncLocallyUpdatedFile({ relativePath: "a.md" });
            await client.waitUntilFinished();
            const result = Buffer.from(
                (await disk.readSnapshot("a.md"))!.content
            ).toString();
            assert.equal(result, "base REMOTE");
        } finally {
            await client?.destroy();
            await server.stop();
        }
    }
);

test(
    "closing an old connection cannot erase its replacement's cursors",
    { timeout: 15000 },
    async () => {
        const server = new ServerControl(
            root + "/sync-server/target/release/sync_server",
            root + "/sync-server/config-e2e.yml",
            new Logger()
        );
        const sockets: WebSocket[] = [];
        try {
            await server.start();
            const url = server.remoteUri + "/vaults/" + randomUUID();
            const id = randomUUID();
            await put(url + "/documents/" + id, content("example"));
            const connect = async (deviceId: string) => {
                const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
                sockets.push(ws);
                await new Promise<void>((resolve, reject) => {
                    ws.onopen = () =>
                        ws.send(
                            JSON.stringify({
                                type: "handshake",
                                token,
                                deviceId,
                                lastSeenVaultUpdateId: 0
                            })
                        );
                    ws.onmessage = () => resolve();
                    ws.onerror = () => reject(new Error("connection failed"));
                });
                return ws;
            };
            const observer = await connect("observer");
            const first = await connect("same-device");
            const sendCursor = (ws: WebSocket, start: number) =>
                ws.send(
                    JSON.stringify({
                        type: "cursorPositions",
                        documentsWithCursors: [
                            {
                                document_id: id,
                                relative_path: "note.md",
                                vault_update_id: 1,
                                cursors: [{ start, end: start }]
                            }
                        ]
                    })
                );
            const seen = (start: number) =>
                new Promise<void>((resolve) => {
                    observer.onmessage = (event) => {
                        const message = JSON.parse(String(event.data));
                        if (
                            message.type === "cursorPositions" &&
                            message.clients.some(
                                (client: {
                                    deviceId: string;
                                    documentsWithCursors: {
                                        cursors: { start: number }[];
                                    }[];
                                }) =>
                                    client.deviceId === "same-device" &&
                                    client.documentsWithCursors[0]?.cursors[0]
                                        ?.start === start
                            )
                        )
                            resolve();
                    };
                });
            let observed = seen(1);
            sendCursor(first, 1);
            await observed;
            const replacement = await connect("same-device");
            observed = seen(2);
            sendCursor(replacement, 2);
            await observed;
            await new Promise<void>((resolve) => {
                first.onclose = () => resolve();
                first.close();
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            const current = new Promise<
                {
                    deviceId: string;
                    documentsWithCursors: { cursors: { start: number }[] }[];
                }[]
            >((resolve) => {
                observer.onmessage = (event) => {
                    const message = JSON.parse(String(event.data));
                    if (message.type === "cursorPositions")
                        resolve(message.clients);
                };
            });
            observer.send(
                JSON.stringify({
                    type: "cursorPositions",
                    documentsWithCursors: []
                })
            );
            const clients = await current;
            assert.equal(
                clients.find((client) => client.deviceId === "same-device")
                    ?.documentsWithCursors[0]?.cursors[0]?.start,
                2
            );
        } finally {
            for (const ws of sockets) ws.close();
            await server.stop();
        }
    }
);
