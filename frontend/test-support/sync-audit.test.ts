import assert from "node:assert/strict";
import { PermanentSyncError } from "../sync-client/src/errors/errors";
import { test } from "node:test";
import type { Database } from "../sync-client/src/persistence/database";
import { emptyState } from "../sync-client/src/persistence/database";
import { SyncClient } from "../sync-client/src/sync-client";
import { toStoredSnapshot } from "../sync-client/src/sync-operations/content";
import { EventListeners } from "../sync-client/src/utils/data-structures/event-listeners";
import type { SyncService } from "../sync-client/src/services/sync-service";
import type { WebSocketManager } from "../sync-client/src/services/websocket-manager";
import { MemoryDisk, MemoryPersistence } from "./storage";

import { fixture, bytes, head } from "./sync-fixture";

test("ignored rename must not produce a duplicate submitted path", async () => {
    const f = await fixture({ "a.md": "A", "b.md": "B" });
    for (const [id, path] of Object.entries(f.database.state.local)) {
        f.database.state.documents[id].base = {
            ...head(id, 1, id.toUpperCase()),
            hash: f.database.state.documents[id].observedHash!
        };
    }
    await f.disk.userRename("a.md", "ignored.md");
    await f.syncer.syncLocallyUpdatedFile({
        oldPath: "a.md",
        relativePath: "ignored.md"
    });
    await f.disk.userRename("b.md", "a.md");
    await f.syncer.syncLocallyUpdatedFile({
        oldPath: "b.md",
        relativePath: "a.md"
    });
    await f.settings.setSettings({ ignorePatterns: ["ignored.md"] });
    await f.internals.scan();
    f.internals.stopped = false;
    await f.internals.preparePush();
    const p = f.database.state.pending;
    assert(p?.type === "fileManifest");
    assert.equal(
        new Set(Object.values(p.request.entries)).size,
        Object.keys(p.request.entries).length
    );
});

test("ignored untracked ancestor must remain in place", async () => {
    const f = await fixture(
        {},
        { getDocumentVersionContent: async () => bytes("remote") }
    );
    await f.disk.userWrite("private", bytes("LOCAL PRIVATE"));
    await f.settings.setSettings({ ignorePatterns: ["private"] });
    f.database.state.remoteHeads.a = head("a", 2, "remote");
    await f.internals.incorporateFileManifest({
        fileManifestId: 3,
        entries: { a: "private/note.md" }
    });
    f.internals.stopped = false;
    await f.internals.preparePush();
    assert.deepEqual(await f.disk.readSnapshot("private"), {
        content: bytes("LOCAL PRIVATE")
    });
});

test("oversized untracked file must remain in place", async () => {
    const f = await fixture(
        {},
        { getDocumentVersionContent: async () => bytes("R") }
    );
    await f.disk.userWrite("a.md", bytes("LOCAL OVERSIZED"));
    await f.settings.setSettings({ maxFileSizeMB: 5 / (1024 * 1024) });
    f.database.state.remoteHeads.a = head("a", 2, "R");
    await f.internals.incorporateFileManifest({
        fileManifestId: 3,
        entries: { a: "a.md" }
    });
    assert.deepEqual(
        (await f.disk.readSnapshot("a.md"))?.content,
        bytes("LOCAL OVERSIZED")
    );
});

test("rejected unknown success must use submitted content as merge base", async () => {
    const f = await fixture(
        { "a.md": "base" },
        {
            putFileContent: async () => {
                throw new PermanentSyncError("HTTP 413");
            },
            getDocumentVersionContent: async ({ vaultUpdateId }) =>
                bytes(
                    vaultUpdateId === 1
                        ? "base"
                        : vaultUpdateId === 2
                          ? "base A"
                          : "base A REMOTE"
                )
        }
    );
    f.database.state.documents.a.base = {
        ...head("a", 1, "base"),
        hash: f.database.state.documents.a.observedHash!
    };
    f.database.state.lastSeenUpdateId = 1;
    await f.disk.userWrite("a.md", bytes("base A"));
    f.internals.stopped = false;
    await f.internals.preparePush();
    const req = f.database.state.pending!.request.requestId;
    await f.internals.finishPending();
    await f.disk.userWrite("a.md", bytes("base"));
    await f.internals.incorporateEventBatch({
        headEventId: 3,
        events: [
            {
                eventId: 2,
                requestId: req,
                type: "content",
                document: head("a", 2, "base A")
            },
            {
                eventId: 3,
                requestId: "other",
                type: "content",
                document: head("a", 3, "base A REMOTE")
            }
        ]
    });
    const result = Buffer.from(
        (await f.disk.readSnapshot("a.md"))!.content
    ).toString();
    assert.equal(result, "base REMOTE");
});

test("bootstrap adopts same-path identity even after multiple notifications", async () => {
    const f = await fixture({});
    f.database.state.initialized = false;
    f.database.state.fileManifest = { fileManifestId: 0, entries: {} };
    await f.disk.userWrite("a.md", bytes("local a"));
    await f.syncer.syncLocallyCreatedFile("a.md");
    await f.disk.userWrite("b.md", bytes("local b"));
    await f.syncer.syncLocallyCreatedFile("b.md");
    const initial = {
        headEventId: 2,
        fileManifest: { fileManifestId: 2, entries: { remoteA: "a.md" } },
        documents: [head("remoteA", 1, "remote a")]
    };
    await f.internals.scan(initial);
    assert.equal(f.database.state.local.remoteA, "a.md");
});

test("oversized remote head must not cause identical stale uploads forever", async () => {
    let attempts = 0;
    const remoteText = "R".repeat(20);
    const f = await fixture(
        { "a.md": "edit" },
        {
            putFileContent: async () => {
                attempts++;
                return {
                    type: "StaleBase",
                    ...head("a", 2, remoteText),
                    contentBase64: Buffer.from(remoteText).toString("base64")
                };
            }
        }
    );
    f.database.state.documents.a.base = {
        ...head("a", 1, "base"),
        hash: (await toStoredSnapshot({ content: bytes("base") })).hash
    };
    f.database.state.remoteHeads.a = head("a", 2, remoteText);
    await f.settings.setSettings({ maxFileSizeMB: 10 / (1024 * 1024) });
    f.internals.stopped = false;
    // Even a small local edit must wait until its required remote base is readable.
    assert.equal(await f.internals.preparePush(), false);
    assert.equal(attempts, 0);
    assert.equal(f.database.state.pending, undefined);
});

test("local undo of accepted-but-rejected manifest must survive replay", async () => {
    const f = await fixture(
        { "a.md": "A" },
        {
            pushFileManifest: async () => {
                throw new PermanentSyncError("HTTP 413");
            },
            getDocumentVersionContent: async () => bytes("A")
        }
    );
    f.database.state.lastSeenUpdateId = 1;
    f.database.state.documents.a.base = {
        ...head("a", 1, "A"),
        hash: f.database.state.documents.a.observedHash!
    };
    await f.disk.userRename("a.md", "b.md");
    await f.syncer.syncLocallyUpdatedFile({
        oldPath: "a.md",
        relativePath: "b.md"
    });
    await f.internals.scan();
    f.internals.stopped = false;
    await f.internals.preparePush();
    const req = f.database.state.pending!.request.requestId;
    f.internals.stopped = true;
    await f.internals.finishPending();
    await f.disk.userRename("b.md", "a.md");
    await f.syncer.syncLocallyUpdatedFile({
        oldPath: "b.md",
        relativePath: "a.md"
    });
    await f.internals.incorporateEventBatch({
        headEventId: 2,
        events: [
            {
                eventId: 2,
                requestId: req,
                type: "fileManifest",
                fileManifest: { fileManifestId: 2, entries: { a: "b.md" } }
            }
        ]
    });
    assert.equal(f.database.state.local.a, "a.md");
});

test("disabled startup should recover an active journal before returning", async () => {
    const disk = new MemoryDisk();
    const key = JSON.stringify(["http://offline.test", "test"]);
    const state = emptyState(key);
    state.initialized = true;
    state.local = { a: "a.md" };
    state.documents = { a: { materialized: true } };
    const next = structuredClone(state);
    next.local = { a: "b.md" };
    const prefix = ".vault-link-sync/transactions/active/a";
    await disk.userWrite(prefix + ".source", bytes("ONLY COPY"));
    state.application = {
        id: "active",
        extensions: ["md"],
        next,
        steps: [
            {
                documentId: "a",
                from: "a.md",
                to: "b.md",
                staged: prefix + ".source",
                output: prefix + ".output",
                phase: "staged"
            }
        ]
    };
    const store = new MemoryPersistence({
        settings: {
            remoteUri: "http://offline.test",
            vaultName: "test",
            isSyncEnabled: false
        },
        database: state
    });
    const client = await SyncClient.create({ fs: disk, persistence: store });
    try {
        await client.start();
        assert.deepEqual(
            (await disk.readSnapshot("b.md"))?.content,
            bytes("ONLY COPY")
        );
    } finally {
        await client.destroy();
    }
});

test("a settings update resumes the enabled engine", async () => {
    const f = await settingsLifecycleFixture();
    try {
        await f.client.setSettings({ maxFileSizeMB: 20 });
        assert.equal(f.client.getSettings().maxFileSizeMB, 20);
        assert.equal(f.store.snapshot().settings?.maxFileSizeMB, 20);
        const before = f.reads();
        await f.client.syncLocallyUpdatedFile({ relativePath: "absent.md" });
        await f.client.waitUntilFinished();
        assert(
            f.reads() > before,
            "notifications must still wake the enabled engine"
        );
    } finally {
        await f.client.destroy();
    }
});

test("a dirty cursor update must invalidate old precise positions", async () => {
    const { CursorTracker } = await import(
        "../sync-client/src/sync-operations/cursor-tracker"
    );
    const { FileChangeNotifier } = await import(
        "../sync-client/src/sync-operations/file-change-notifier"
    );
    const f = await fixture({ "a.md": "base" });
    f.database.state.documents.a.base = {
        ...head("a", 1, "base"),
        hash: f.database.state.documents.a.observedHash!
    };
    const ws = {
        onWebSocketStatusChanged: new EventListeners(),
        onRemoteCursorsUpdateReceived: new EventListeners(),
        updateLocalCursors: () => {}
    };
    const tracker = new CursorTracker(
        f.database,
        ws as unknown as WebSocketManager,
        f.files,
        new FileChangeNotifier()
    );
    let latest: import("../sync-client/src/types/maybe-outdated-client-cursors").MaybeOutdatedClientCursors[] =
        [];
    tracker.onRemoteCursorsUpdated.add((cursors) => {
        latest = cursors;
    });
    const clean = {
        userName: "other",
        deviceId: "other",
        documentsWithCursors: [
            {
                document_id: "a",
                relative_path: "a.md",
                vault_update_id: 1,
                cursors: [{ start: 0, end: 0 }]
            }
        ]
    };
    await ws.onRemoteCursorsUpdateReceived.triggerAsync([clean]);
    await ws.onRemoteCursorsUpdateReceived.triggerAsync([
        {
            ...clean,
            documentsWithCursors: [
                {
                    ...clean.documentsWithCursors[0],
                    vault_update_id: null,
                    cursors: [{ start: 100, end: 100 }]
                }
            ]
        }
    ]);
    assert.equal(latest[0]?.isOutdated, true);
    tracker.reset();
});

test("silent open WebSocket must eventually trigger catchup or reconnect", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let opens = 0,
        eventReads = 0;
    class SilentWebSocket {
        static OPEN = 1;
        readyState = 1;
        onopen: ((event: object) => void) | null = null;
        onclose: ((event: { code: number; reason: string }) => void) | null =
            null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: ((event: object) => void) | null = null;
        constructor(_url: string | URL) {
            opens++;
            queueMicrotask(() => this.onopen?.({}));
        }
        send(_message: string) {}
        close() {
            this.readyState = 3;
            this.onclose?.({ code: 1000, reason: "" });
        }
    }
    const store = new MemoryPersistence({
        settings: {
            isSyncEnabled: true,
            remoteUri: "http://silent.test",
            vaultName: "test",
            token: "test",
            syncIntervalMs: 0
        }
    });
    const client = await SyncClient.create({
        fs: new MemoryDisk(),
        persistence: store,
        webSocket: SilentWebSocket as unknown as typeof WebSocket,
        fetch: async (input) => {
            const path = String(input);
            if (path.endsWith("/ping"))
                return Response.json({
                    supportedApiVersion: 5,
                    isAuthenticated: true,
                    mergeableFileExtensions: ["md"],
                    serverVersion: "test"
                });
            if (path.endsWith("/vault-snapshot"))
                return Response.json({
                    headEventId: 0,
                    fileManifest: { fileManifestId: 0, entries: {} },
                    documents: []
                });
            if (path.includes("/events-since")) {
                eventReads++;
                return Response.json({ headEventId: 0, events: [] });
            }
            throw new Error("Unexpected request " + path);
        }
    });
    try {
        await client.start();
        const before = eventReads;
        context.mock.timers.tick(45_000);
        context.mock.timers.tick(3500);
        for (let i = 0; i < 30; i++) await Promise.resolve();
        assert(opens > 1 || eventReads > before);
    } finally {
        await client.destroy();
    }
});

test("oversized files should be filtered before reading complete snapshots", async () => {
    const f = await fixture({});
    await f.disk.userWrite("huge.bin", bytes("too big"));
    await f.settings.setSettings({ maxFileSizeMB: 1 / (1024 * 1024) });
    let reads = 0;
    f.disk.boundary = (label) => {
        if (label === "read:snapshot:huge.bin") reads++;
    };
    await f.internals.scan();
    assert.equal(reads, 0);
});

test("permanent destination failure replans the affected file and finishes the batch", async () => {
    const f = await fixture({ "a.md": "A", "b.md": "B" });
    f.disk.boundary = (label) => {
        if (label === "before:mkdir:unsupported")
            throw Object.assign(new Error("filesystem path limit"), {
                code: "ENAMETOOLONG"
            });
    };
    const next = structuredClone(f.database.state);
    next.local = { a: "unsupported/a.md", b: "good.md" };
    next.fileManifest = { fileManifestId: 2, entries: { ...next.local } };
    await f.files.apply(next);
    await f.settings.setSettings({ ignorePatterns: ["unsupported/**"] });
    await f.files.recover();
    assert.deepEqual(
        [...f.disk.userFiles().values()]
            .map((b) => Buffer.from(b).toString())
            .sort(),
        ["A", "B"]
    );
});

test("conflict allocation terminates when a truncated extension ends in a space", async () => {
    const { spawnSync } = await import("node:child_process");
    const modulePath = require.resolve(
        "../sync-client/src/utils/portable-path"
    );
    const result = spawnSync(
        process.execPath,
        [
            "--require",
            require.resolve("tsx/cjs"),
            "-e",
            `
        const {allocatePortablePath,validatePortablePaths} = require(${JSON.stringify(modulePath)});
        const name = 'a.' + 'x'.repeat(62) + ' ' + 'x'.repeat(100);
        const allocated = allocatePortablePath(name, 'new', {old:name});
        validatePortablePaths([name, allocated]);
        if (Buffer.byteLength(allocated) > 255) process.exit(2);
    `
        ],
        { timeout: 3000, encoding: "utf8" }
    );
    assert.equal(result.status, 0, String(result.error ?? result.stderr));
});

test("paged catchup folds remote edits and reversions before touching local bytes", async () => {
    const f = await fixture(
        { "a.md": "base LOCAL" },
        { getDocumentVersionContent: async () => bytes("base") }
    );
    f.database.state.documents.a.base = {
        ...head("a", 1, "base"),
        hash: (await toStoredSnapshot({ content: bytes("base") })).hash
    };
    f.database.state.remoteHeads.a = head("a", 1, "base");
    f.database.state.lastSeenUpdateId = 1;
    const first = {
        headEventId: 3,
        endEventId: 2,
        events: [
            {
                eventId: 2,
                requestId: "remote-1",
                type: "content" as const,
                document: head("a", 2, "base REMOTE")
            }
        ]
    };
    await f.internals.incorporateEventBatch(first);
    assert.equal(
        f.database.state.lastSeenUpdateId,
        1,
        "partial history must not become an incorporated base"
    );
    assert.deepEqual(
        (await f.disk.readSnapshot("a.md"))?.content,
        bytes("base LOCAL")
    );
    assert.equal(
        await f.internals.preparePush(),
        false,
        "do not submit against a partially replayed history"
    );
    const last = {
        headEventId: 3,
        endEventId: 3,
        events: [
            {
                eventId: 3,
                requestId: "remote-2",
                type: "content" as const,
                document: head("a", 3, "base")
            }
        ]
    };
    await f.internals.incorporateEventBatch(last);
    assert.equal(f.database.state.lastSeenUpdateId, 3);
    assert.deepEqual(
        (await f.disk.readSnapshot("a.md"))?.content,
        bytes("base LOCAL")
    );
});

test("an ignored occupant arriving after the scan keeps its path and privacy", async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture(
        {},
        {
            getDocumentVersionContent: async () => {
                await f.disk.userWrite("private", bytes("SECRET"));
                return bytes("remote");
            }
        }
    );
    await f.settings.setSettings({ ignorePatterns: ["private"] });
    f.database.state.remoteHeads.a = head("a", 2, "remote");
    await f.internals.incorporateFileManifest({
        fileManifestId: 3,
        entries: { a: "private/note.md" }
    });
    assert.deepEqual(
        (await f.disk.readSnapshot("private"))?.content,
        bytes("SECRET")
    );
    f.internals.stopped = false;
    await f.internals.preparePush();
    const { pending } = f.database.state;
    assert(
        pending?.type !== "content" ||
            Buffer.from(pending.snapshot.contentBase64, "base64").toString() !==
                "SECRET"
    );
});

test("content notifications during every snapshot do not starve a complete namespace scan", async () => {
    const f = await fixture({ "a.md": "A", "b.md": "B" });
    let notifications = 0;
    f.disk.boundary = async (label) => {
        if (
            label.startsWith("read:snapshot:") &&
            !label.includes(".vault-link-sync")
        ) {
            notifications++;
            await f.syncer.syncLocallyUpdatedFile({
                relativePath: label.slice("read:snapshot:".length)
            });
        }
    };
    await f.internals.scan();
    assert.equal(notifications, 2);
    assert.deepEqual(f.database.state.local, { a: "a.md", b: "b.md" });
});

for (const boundary of ["before:save", "durable:save"]) {
    test(`receipt incorporation after paged replay survives ${boundary} and process replacement`, async () => {
        const service: Partial<SyncService> = {
            putFileContent: async () => {
                throw new PermanentSyncError("HTTP 413");
            },
            getDocumentVersionContent: async ({ vaultUpdateId }) =>
                bytes(
                    vaultUpdateId === 1
                        ? "base"
                        : vaultUpdateId === 2
                          ? "base A"
                          : "base A REMOTE"
                )
        };
        let f = await fixture({ "a.md": "base" }, service);
        f.database.state.documents.a.base = {
            ...head("a", 1, "base"),
            hash: f.database.state.documents.a.observedHash!
        };
        f.database.state.lastSeenUpdateId = 1;
        await f.disk.userWrite("a.md", bytes("base A"));
        f.internals.stopped = false;
        await f.internals.preparePush();
        const { requestId } = f.database.state.pending!.request;
        await f.internals.finishPending();
        await f.disk.userWrite("a.md", bytes("base"));
        await f.internals.incorporateEventBatch({
            headEventId: 3,
            endEventId: 2,
            events: [
                {
                    eventId: 2,
                    requestId,
                    type: "content",
                    document: head("a", 2, "base A")
                }
            ]
        });
        const page = {
            headEventId: 3,
            endEventId: 3,
            events: [
                {
                    eventId: 3,
                    requestId: "other",
                    type: "content" as const,
                    document: head("a", 3, "base A REMOTE")
                }
            ]
        };
        f.persistence.boundary = (label) => {
            if (label === boundary) throw new Error("injected crash");
        };
        await assert.rejects(
            f.internals.incorporateEventBatch(page),
            /injected crash/
        );
        f.persistence.boundary = () => {};
        f.disk.crash(true);
        f = await fixture({}, service, f);
        await f.files.recover();
        assert.equal(f.database.state.eventReplay?.after, 2);
        await f.internals.incorporateEventBatch(page);
        assert.equal(f.database.state.eventReplay, undefined);
        assert.equal(f.database.state.lastSeenUpdateId, 3);
        assert.deepEqual(
            (await f.disk.readSnapshot("a.md"))?.content,
            bytes("base REMOTE")
        );
    });
}

test("initial vault settings bind the engine and survive restart", async () => {
    const disk = new MemoryDisk();
    const persistence = new MemoryPersistence({
        settings: {
            remoteUri: "http://test",
            vaultName: "old",
            isSyncEnabled: false
        }
    });
    class Socket {
        static OPEN = 1;
        readyState = 3;
        onopen = null;
        onclose = null;
        onerror = null;
        onmessage = null;
        send() {}
        close() {}
    }
    const options = {
        fs: disk,
        persistence,
        webSocket: Socket as unknown as typeof WebSocket,
        fetch: async (input: RequestInfo | URL) => {
            if (String(input).endsWith("/ping"))
                return Response.json({
                    supportedApiVersion: 5,
                    isAuthenticated: true,
                    mergeableFileExtensions: ["md"],
                    serverVersion: "test"
                });
            if (String(input).endsWith("/vault-snapshot"))
                return Response.json({
                    headEventId: 0,
                    fileManifest: { fileManifestId: 0, entries: {} },
                    documents: []
                });
            return Response.json({ headEventId: 0, events: [] });
        }
    };
    let client = await SyncClient.create(options);
    try {
        await client.setSettings({ vaultName: "new", isSyncEnabled: true });
        await client.start();
        await client.destroy();
        client = await SyncClient.create(options);
        assert.equal(client.getSettings().vaultName, "new");
        await client.start();
    } finally {
        await client.destroy();
    }
});

test("disabling sync persists across reset without resuming the transport", async () => {
    const f = await settingsLifecycleFixture();
    try {
        const before = f.reads();
        await f.client.setSettings({ isSyncEnabled: false });
        assert.equal(f.store.snapshot().settings?.isSyncEnabled, false);
        await f.client.reset();
        assert.equal(f.client.getSettings().isSyncEnabled, false);
        assert.equal(f.reads(), before);
    } finally {
        await f.client.destroy();
    }
});

for (const receipt of [false, true]) {
    test(`${receipt ? "replayed" : "direct"} upload acknowledgement survives a local deletion`, async () => {
        const f = await fixture(
            { "a.md": "base" },
            {
                putFileContent: async () => {
                    if (receipt)
                        throw new PermanentSyncError(
                            "HTTP 413 after lost success"
                        );
                    return { type: "Accepted", ...head("a", 2, "edited") };
                }
            }
        );
        f.database.state.documents.a.base = {
            ...head("a", 1, "base"),
            hash: f.database.state.documents.a.observedHash!
        };
        f.database.state.lastSeenUpdateId = 1;
        await f.disk.userWrite("a.md", bytes("edited"));
        f.internals.stopped = false;
        await f.internals.preparePush();
        const { requestId } = f.database.state.pending!.request;
        if (receipt) await f.internals.finishPending();
        // Recovery folds queued deletions into the durable namespace before
        // an outstanding request or its delayed receipt is handled.
        f.internals.stopped = true;
        await f.disk.userDelete("a.md");
        await f.syncer.syncLocallyDeletedFile("a.md");
        await f.internals.scan();
        assert.deepEqual(f.database.state.local, {});
        if (receipt) {
            await f.internals.incorporateEventBatch({
                headEventId: 2,
                events: [
                    {
                        eventId: 2,
                        requestId,
                        type: "content",
                        document: head("a", 2, "edited")
                    }
                ]
            });
            assert.equal(f.database.state.lastSeenUpdateId, 2);
            assert.equal(f.database.state.unconfirmed?.length ?? 0, 0);
        } else await f.internals.finishPending();
        assert.equal(f.database.state.pending, undefined);
        assert.deepEqual(f.database.state.local, {});
        assert.equal(await f.disk.readSnapshot("a.md"), undefined);
        assert.equal(f.database.state.documents.a.base?.vaultUpdateId, 2);
    });
}

async function settingsLifecycleFixture() {
    let eventReads = 0;
    let onClose = () => {};
    class Socket {
        static OPEN = 1;
        readyState = 1;
        onopen: (() => void) | null = null;
        onclose: ((event: { code: number; reason: string }) => void) | null =
            null;
        constructor() {
            queueMicrotask(() => this.onopen?.());
        }
        send() {}
        close() {
            onClose();
            this.readyState = 3;
            this.onclose?.({ code: 1000, reason: "" });
        }
    }
    const store = new MemoryPersistence({
        settings: {
            remoteUri: "http://test",
            vaultName: "test",
            isSyncEnabled: true
        }
    });
    const client = await SyncClient.create({
        fs: new MemoryDisk(),
        persistence: store,
        webSocket: Socket as unknown as typeof WebSocket,
        fetch: async (input) => {
            const path = String(input);
            if (path.endsWith("/ping"))
                return Response.json({
                    supportedApiVersion: 5,
                    isAuthenticated: true,
                    mergeableFileExtensions: ["md"],
                    serverVersion: "test"
                });
            if (path.endsWith("/vault-snapshot"))
                return Response.json({
                    headEventId: 0,
                    fileManifest: { fileManifestId: 0, entries: {} },
                    documents: []
                });
            if (path.includes("/events-since")) {
                eventReads++;
                return Response.json({ headEventId: 0, events: [] });
            }
            throw new Error("Unexpected request " + path);
        }
    });
    await client.start();
    return {
        client,
        store,
        reads: () => eventReads,
        onClose: (fn: () => void) => {
            onClose = fn;
        }
    };
}

for (const boundary of ["before:save", "durable:save"]) {
    test(`settings recovery resumes after the rejection-reset save fails at ${boundary}`, async () => {
        const f = await settingsLifecycleFixture();
        try {
            const { database } = f.client as unknown as { database: Database };
            await database.commit({
                ...database.state,
                rejectedManifest: {
                    entries: { retired: "old.md" },
                    message: "retired rejection"
                }
            });
            let saves = 0,
                failed = false;
            f.store.boundary = (label) => {
                if (label === "before:save") saves++;
                if (saves === 2 && label === boundary && !failed) {
                    failed = true;
                    throw new Error("rejection-reset save failed");
                }
            };
            await assert.rejects(
                f.client.setSettings({ maxFileSizeMB: 20 }),
                /rejection-reset save failed/
            );
            assert(failed);
            assert.equal(f.client.getSettings().maxFileSizeMB, 20);
            const before = f.reads();
            await f.client.syncLocallyUpdatedFile({
                relativePath: "absent.md"
            });
            await f.client.waitUntilFinished();
            assert(
                f.reads() > before,
                "the enabled engine must resume after any settings-phase save failure"
            );
        } finally {
            await f.client.destroy();
        }
    });
}

test("a caller cannot mutate settings while transports are being paused", async () => {
    const f = await settingsLifecycleFixture();
    const change = {
        maxFileSizeMB: 20,
        vaultName: "test",
        ignorePatterns: ["private/**"]
    };
    try {
        f.onClose(() => {
            change.vaultName = "wrong-vault";
            change.ignorePatterns.push("**");
        });
        await f.client.setSettings(change);
        assert.equal(f.client.getSettings().vaultName, "test");
        assert.deepEqual(f.client.getSettings().ignorePatterns, ["private/**"]);
        assert.equal(
            f.store.snapshot().database?.vaultKey,
            JSON.stringify(["http://test", "test"])
        );
    } finally {
        await f.client.destroy();
    }
});
