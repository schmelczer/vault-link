import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { Logger } from "sync-client";
import { ServerControl } from "../deterministic-tests/src/server-control";
import { MemoryDisk, type DiskImage, type StoredClient } from "./storage";
import { getJson, type CanonicalSnapshot } from "./canonical";
import type { RequestRecord } from "./network";
import type { CrashWorkerInput } from "../deterministic-tests/src/crash-worker";

const root = path.resolve(__dirname, "../..");
const token = "test-token-change-me";
const headers = {
    Authorization: `Bearer ${token}`,
    "Device-Id": "protocol-test",
    "Content-Type": "application/json"
};
const makeServer = () =>
    new ServerControl(
        path.join(root, "sync-server/target/release/sync_server"),
        path.join(root, "sync-server/config-e2e.yml"),
        new Logger()
    );
async function put(url: string, body: unknown) {
    const response = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000)
    });
    assert(
        response.ok,
        `HTTP ${response.status}: ${await response.clone().text()}`
    );
    return (await response.json()) as {
        type: string;
        vaultUpdateId: number;
        fileManifestId: number;
    };
}
const content = (text: string, parentVersionId: number | null = null) => ({
    requestId: randomUUID(),
    parentVersionId,
    content: { type: "Snapshot", value: Buffer.from(text).toString("base64") }
});

interface WorkerSnapshot {
    type: string;
    disk: DiskImage;
    stored: StoredClient;
    requests: RequestRecord[];
    editedBase?: { documentId: string; vaultUpdateId: number };
}
async function runWorker(input: CrashWorkerInput): Promise<WorkerSnapshot> {
    const worker = new Worker(
        path.join(root, "frontend/deterministic-tests/dist/crash-worker.js"),
        { workerData: input }
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await new Promise<WorkerSnapshot>((resolve, reject) => {
            timeout = setTimeout(
                () =>
                    reject(new Error("Worker checkpoint/completion timed out")),
                15_000
            );
            worker.once("error", reject);
            worker.once("exit", (code) =>
                reject(
                    new Error(
                        `Worker exited (${code}) before expected checkpoint`
                    )
                )
            );
            worker.on(
                "message",
                (message: WorkerSnapshot & { error?: string }) => {
                    if (message.type === "error")
                        reject(new Error(message.error));
                    else {
                        assert.equal(
                            message.type,
                            input.stopAt ? "checkpoint" : "finished"
                        );
                        resolve(message);
                    }
                }
            );
        });
    } finally {
        clearTimeout(timeout);
        // This is the fault injection, not graceful shutdown masquerading as it.
        await worker.terminate();
    }
}

for (const [kind, format, originalPath] of [
    ["create", "Snapshot", "original.md"],
    ["content", "Snapshot", "original.bin"],
    ["content", "Diff", "original.md"],
    ["manifest", undefined, "original.md"]
] as const) {
    test(
        `abrupt client death after accepted ${kind} ${format ?? ""} reply, newer head, server SIGKILL, durable retry`,
        { timeout: 30_000 },
        async () => {
            const server = makeServer();
            try {
                await server.start();
                const vault = `crash-${randomUUID()}`;
                const url = `${server.remoteUri}/vaults/${vault}`;
                const disk = new MemoryDisk();
                await disk.userWrite(
                    originalPath,
                    new TextEncoder().encode("preserve-original\n")
                );
                let input: CrashWorkerInput = {
                    disk: disk.image(),
                    stored: {
                        settings: {
                            isSyncEnabled: true,
                            enableTelemetry: false,
                            remoteUri: server.remoteUri,
                            vaultName: vault,
                            token,
                            requestTimeoutMs: 5_000,
                            syncIntervalMs: 0
                        }
                    } as StoredClient
                };
                let originalId: string | undefined;
                let originalParent: number | undefined;
                let uploaded = "preserve-original\n";
                if (kind === "content" && format === "Diff") {
                    // Keep the established base in the worker's real content
                    // cache; a cold restart intentionally falls back to Snapshot.
                    uploaded += "local-update\n";
                    input.editAfterSync = {
                        path: originalPath,
                        content: uploaded
                    };
                } else if (kind === "content") {
                    const initialized = await runWorker(input);
                    originalId = Object.keys(
                        initialized.stored.database!.local!
                    )[0];
                    originalParent =
                        initialized.stored.database!.documents![originalId]
                            .base!.vaultUpdateId;
                    disk.restore(initialized.disk);
                    uploaded += "local-update\n";
                    await disk.userWrite(
                        originalPath,
                        new TextEncoder().encode(uploaded)
                    );
                    input = { disk: disk.image(), stored: initialized.stored };
                }
                const checkpoint = await runWorker({ ...input, stopAt: kind });
                if (format === "Diff") {
                    assert(
                        checkpoint.editedBase,
                        "Warm update baseline was not recorded"
                    );
                    originalId = checkpoint.editedBase.documentId;
                    originalParent = checkpoint.editedBase.vaultUpdateId;
                }
                const pending = checkpoint.stored.database!.pending!;
                assert(
                    pending,
                    "The uncertain request was not persisted before sending"
                );
                const interrupted = checkpoint.requests.at(-1)!;
                assert.equal(
                    interrupted.kind,
                    kind,
                    "Wrong CAS was interrupted"
                );
                if (kind !== "manifest") {
                    assert.equal(pending.type, "content");
                    assert(pending.type === "content");
                    assert.equal(pending.request.content.type, format);
                    assert.equal(
                        pending.request.parentVersionId,
                        kind === "create" ? null : originalParent
                    );
                    if (originalId)
                        assert.equal(
                            pending.documentId,
                            originalId,
                            "Update created a replacement UUID"
                        );
                }
                const accepted = await getJson<CanonicalSnapshot>(
                    `${url}/vault-snapshot`,
                    token
                );
                // Unpublished content has no manifest membership yet, so it is
                // deliberately absent from /vault-snapshot's document list.
                const doc =
                    pending.type === "content"
                        ? await getJson<{
                              documentId: string;
                              vaultUpdateId: number;
                          }>(`${url}/documents/${pending.documentId}`, token)
                        : accepted.documents[0];
                assert(doc);
                const remote = await put(
                    `${url}/documents/${doc.documentId}`,
                    content(`${uploaded}remote-update\n`, doc.vaultUpdateId)
                );
                assert.equal(remote.type, "Accepted");
                const remotePath = originalPath.replace("original", "remote");
                const renamed = await put(`${url}/file-manifest`, {
                    requestId: randomUUID(),
                    parentFileManifestId: accepted.fileManifest.fileManifestId,
                    entries: { [doc.documentId]: remotePath }
                });
                assert.equal(renamed.type, "Accepted");
                const before = await getJson<CanonicalSnapshot>(
                    `${url}/vault-snapshot`,
                    token
                );
                await server.crash();
                await server.restart();
                assert.deepEqual(
                    await getJson(`${url}/vault-snapshot`, token),
                    before,
                    "Server restart lost acknowledged state"
                );
                const restarted = await runWorker({
                    disk: checkpoint.disk,
                    stored: checkpoint.stored
                });
                const replay = restarted.requests.find(
                    (r) => r.body.requestId === pending.request.requestId
                );
                assert(replay, "Restart never retried the uncertain request");
                assert.equal(
                    replay.url,
                    interrupted.url,
                    "Restart changed the request target"
                );
                assert.deepEqual(
                    replay.body,
                    pending.request,
                    "Restart changed the persisted request"
                );
                assert.equal(restarted.stored.database!.pending, undefined);
                assert.equal(restarted.stored.database!.application, undefined);
                const recovered = new MemoryDisk();
                recovered.restore(restarted.disk);
                assert.deepEqual(
                    recovered.userFiles(),
                    new Map([
                        [
                            remotePath,
                            new TextEncoder().encode(
                                `${uploaded}remote-update\n`
                            )
                        ]
                    ])
                );
                assert.deepEqual(restarted.stored.database!.local, {
                    [doc.documentId]: remotePath
                });
                const events = await getJson<{
                    events: { requestId: string }[];
                }>(`${url}/events-since?after=0`, token);
                assert.equal(
                    events.events.filter(
                        (e) => e.requestId === pending.request.requestId
                    ).length,
                    1,
                    "Retry emitted a duplicate event"
                );
            } finally {
                await server.stop();
            }
        }
    );
}

test(
    "concurrent CAS commits have identical HTTP/event-log/WebSocket total order and reconnect catchup",
    { timeout: 20_000 },
    async () => {
        const server = makeServer();
        let ws: WebSocket | undefined;
        try {
            await server.start();
            const url = `${server.remoteUri}/vaults/order-${randomUUID()}`;
            const received: number[] = [];
            const connect = async (after: number) => {
                ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
                ws.addEventListener("message", (message) => {
                    const batch = JSON.parse(String(message.data)) as {
                        type: string;
                        events: { eventId: number }[];
                    };
                    if (batch.type === "vaultEvents")
                        received.push(
                            ...batch.events.map((event) => event.eventId)
                        );
                });
                await new Promise<void>((resolve, reject) => {
                    ws!.onopen = () => resolve();
                    ws!.onerror = () => reject(new Error("WebSocket failed"));
                });
                ws.send(
                    JSON.stringify({
                        type: "handshake",
                        token,
                        deviceId: "order-observer",
                        lastSeenVaultUpdateId: after
                    })
                );
            };
            await connect(0);
            const ids = Array.from({ length: 12 }, () => randomUUID());
            const requests = ids.map((id, i) => ({
                id,
                body: content(`bytes-${i}`)
            }));
            const replies = await Promise.all(
                requests.map(({ id, body }) =>
                    put(`${url}/documents/${id}`, body)
                )
            );
            assert.deepEqual(
                replies.map((r) => r.vaultUpdateId).sort((a, b) => a - b),
                ids.map((_, i) => i + 1)
            );
            const emptyManifest = await getJson<{
                entries: Record<string, string>;
            }>(`${url}/file-manifest`, token);
            assert.deepEqual(
                emptyManifest.entries,
                {},
                "Content-only CAS changed membership"
            );
            const entries = Object.fromEntries(
                ids.map((id, i) => [id, `${i}.md`])
            );
            await put(`${url}/file-manifest`, {
                requestId: randomUUID(),
                parentFileManifestId: 0,
                entries
            });
            // All retries must return original receipts without emitting events.
            assert.deepEqual(
                await Promise.all(
                    requests.map(({ id, body }) =>
                        put(`${url}/documents/${id}`, body)
                    )
                ),
                replies
            );
            const waitForEvents = async (head: number) => {
                const deadline = Date.now() + 5_000;
                while (received.length < head && Date.now() < deadline)
                    await new Promise((resolve) => setTimeout(resolve, 10));
                assert.deepEqual(
                    received,
                    Array.from({ length: head }, (_, i) => i + 1),
                    "WebSocket reordered, lost or duplicated an event"
                );
            };
            await waitForEvents(13);
            await new Promise<void>((resolve) => {
                ws!.onclose = () => resolve();
                ws!.close();
            });
            await put(
                `${url}/documents/${ids[0]}`,
                content("next", replies[0].vaultUpdateId)
            );
            await connect(13);
            await waitForEvents(14);
            const log = await getJson<{ events: { eventId: number }[] }>(
                `${url}/events-since?after=0`,
                token
            );
            assert.deepEqual(
                received,
                log.events.map((event) => event.eventId)
            );
            const stale = await put(`${url}/file-manifest`, {
                requestId: randomUUID(),
                parentFileManifestId: 0,
                entries: {}
            });
            assert.equal(stale.type, "StaleBase");
            const invalid = await fetch(`${url}/file-manifest`, {
                method: "PUT",
                headers,
                body: JSON.stringify({
                    requestId: randomUUID(),
                    parentFileManifestId: 13,
                    entries: { [ids[0]]: "same", [ids[1]]: "same" }
                })
            });
            assert.equal(invalid.status, 422);
            assert.equal(
                (
                    await getJson<CanonicalSnapshot>(
                        `${url}/vault-snapshot`,
                        token
                    )
                ).headEventId,
                14,
                "Rejected CAS emitted an event"
            );
        } finally {
            ws?.close();
            await server.stop();
        }
    }
);
