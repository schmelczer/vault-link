import assert from "node:assert/strict";
import { test } from "node:test";
import {
    Database,
    emptyState,
    type StoredDatabase
} from "../sync-client/src/persistence/database";
import { Settings } from "../sync-client/src/persistence/settings";
import { FileOperations } from "../sync-client/src/file-operations/file-operations";
import { Syncer } from "../sync-client/src/sync-operations/syncer";
import { toStoredSnapshot } from "../sync-client/src/sync-operations/content";
import { Logger } from "../sync-client/src/tracing/logger";
import { SyncHistory } from "../sync-client/src/tracing/sync-history";
import { FixedSizeDocumentCache } from "../sync-client/src/utils/data-structures/fix-sized-cache";
import { EventListeners } from "../sync-client/src/utils/data-structures/event-listeners";
import type { SyncService } from "../sync-client/src/services/sync-service";
import type { ServerConfig } from "../sync-client/src/services/server-config";
import type { WebSocketManager } from "../sync-client/src/services/websocket-manager";
import type { EventBatch } from "../sync-client/src/services/types/EventBatch";
import type { EventRecord } from "../sync-client/src/services/types/EventRecord";
import type { PutFileContent } from "../sync-client/src/services/types/PutFileContent";
import { MemoryDisk, MemoryPersistence } from "./storage";

const documentId = "00000000-0000-4000-8000-000000000001";
const interval = 1_000;
const retryInterval = 75;
const bytes = (text: string) => new TextEncoder().encode(text);

/** Real sync loop over in-memory disk/persistence and an observable version
 * store. The transport never wakes the engine itself. */
async function fixture(syncIntervalMs: number | undefined) {
    const disk = new MemoryDisk();
    await disk.userWrite("note.bin", bytes("base"));
    let headEventId = 2; // Initial content (1), then manifest (2).
    const versions = new Map([[1, bytes("base")]]);
    const head = (version: number) => ({
        documentId,
        vaultUpdateId: version,
        contentSize: versions.get(version)!.length,
        updatedDate: "2026-09-20T00:00:00Z",
        userId: "user",
        deviceId: "device"
    });
    let latest = head(1);
    const events: EventRecord[] = [];
    const writes: PutFileContent[] = [];
    let eventReads = 0;
    let failNextRead = false;
    const publishContent = (content: Uint8Array, requestId: string) => {
        const eventId = ++headEventId;
        versions.set(eventId, new Uint8Array(content));
        latest = head(eventId);
        events.push({ eventId, requestId, type: "content", document: latest });
        return latest;
    };
    const batch = (after = 2): EventBatch =>
        structuredClone({
            headEventId,
            events: events.filter((event) => event.eventId > after)
        });
    const service: Partial<SyncService> = {
        events: async (after) => {
            eventReads++;
            if (failNextRead) {
                failNextRead = false;
                throw new Error("offline");
            }
            return batch(after);
        },
        getDocumentVersionContent: async ({ vaultUpdateId }) => {
            const content = versions.get(vaultUpdateId);
            assert(content, `Missing immutable version ${vaultUpdateId}`);
            return content.slice();
        },
        putFileContent: async (id, request) => {
            assert.equal(id, documentId);
            assert.equal(request.parentVersionId, latest.vaultUpdateId);
            assert(request.content.type === "Snapshot");
            writes.push(structuredClone(request));
            return {
                type: "Accepted",
                ...publishContent(
                    Buffer.from(request.content.value, "base64"),
                    request.requestId
                )
            };
        }
    };
    const initial = emptyState("polling-test");
    initial.initialized = true;
    initial.lastSeenUpdateId = 2;
    initial.local = { [documentId]: "note.bin" };
    initial.fileManifest = { fileManifestId: 2, entries: { ...initial.local } };
    initial.remoteHeads = { [documentId]: latest };
    const hash = (await toStoredSnapshot({ content: bytes("base") })).hash;
    initial.documents[documentId] = {
        materialized: true,
        observedHash: hash,
        base: { ...latest, hash }
    };
    const persistence = new MemoryPersistence({ database: initial });
    const logger = new Logger();
    const database = new Database(
        initial,
        async (next) => persistence.save({ database: next }),
        initial.vaultKey,
        async () => (await persistence.load()).database as StoredDatabase
    );
    const settings = new Settings(
        logger,
        { syncIntervalMs, networkRetryIntervalMs: retryInterval },
        async () => {}
    );
    const config = {
        initialize: async () => {},
        getConfig: async () => ({ mergeableFileExtensions: [] }),
        reset: () => {}
    } as unknown as ServerConfig;
    const websocket = {
        onWebSocketStatusChanged: new EventListeners<
            (connected: boolean) => unknown
        >(),
        onRemoteVaultUpdateReceived: new EventListeners<
            (batch: EventBatch) => Promise<void>
        >()
    };
    const syncer = new Syncer(
        "device",
        logger,
        database,
        settings,
        service as SyncService,
        websocket as unknown as WebSocketManager,
        new FileOperations(disk.session(), database, config),
        config,
        new SyncHistory(logger),
        new FixedSizeDocumentCache(0)
    );
    return {
        disk,
        database,
        syncer,
        writes,
        batch,
        websocket,
        reads: () => eventReads,
        serverContent: () => versions.get(latest.vaultUpdateId),
        failNextRead: () => {
            failNextRead = true;
        },
        changeRemote: () => {
            publishContent(bytes("remote edit"), "remote-content");
            const eventId = ++headEventId;
            events.push({
                eventId,
                requestId: "remote-rename",
                type: "fileManifest",
                fileManifest: {
                    fileManifestId: eventId,
                    entries: { [documentId]: "renamed.bin" }
                }
            });
        }
    };
}

for (const syncIntervalMs of [undefined, 0, interval]) {
    for (const side of ["local", "remote"] as const) {
        test(`${side} changes without notifications ${syncIntervalMs ? "are recovered by explicit polling" : `remain unobserved when polling is ${syncIntervalMs === 0 ? "zero" : "unset"}`}`, async (context) => {
            context.mock.timers.enable({ apis: ["setTimeout"] });
            const f = await fixture(syncIntervalMs);
            try {
                f.syncer.start();
                await f.syncer.waitUntilFinished();
                const reads = f.reads();
                if (side === "local")
                    await f.disk.userWrite("note.bin", bytes("local edit"));
                else f.changeRemote();
                const assertUnobserved = () => {
                    assert.equal(
                        f.reads(),
                        reads,
                        "A hidden wakeup fetched events"
                    );
                    assert.equal(f.database.state.lastSeenUpdateId, 2);
                    assert.equal(f.writes.length, 0);
                    assert.deepEqual(
                        f.serverContent(),
                        bytes(side === "local" ? "base" : "remote edit")
                    );
                    assert.deepEqual(
                        f.disk.userFiles(),
                        new Map([
                            [
                                "note.bin",
                                bytes(side === "local" ? "local edit" : "base")
                            ]
                        ])
                    );
                };
                context.mock.timers.tick(
                    syncIntervalMs ? interval - 1 : 60_000
                );
                await f.syncer.waitUntilFinished();
                assertUnobserved();
                if (syncIntervalMs) context.mock.timers.tick(1);
                else if (side === "local")
                    await f.syncer.syncLocallyUpdatedFile({
                        relativePath: "note.bin"
                    });
                else
                    await f.websocket.onRemoteVaultUpdateReceived.triggerAsync(
                        f.batch()
                    );
                await f.syncer.waitUntilFinished();
                const content = bytes(
                    side === "local" ? "local edit" : "remote edit"
                );
                const path = side === "local" ? "note.bin" : "renamed.bin";
                assert.deepEqual(f.serverContent(), content);
                assert.deepEqual(
                    f.disk.userFiles(),
                    new Map([[path, content]])
                );
                assert.deepEqual(f.database.state.local, {
                    [documentId]: path
                });
                assert.equal(
                    f.database.state.lastSeenUpdateId,
                    side === "local" ? 3 : 4
                );
                assert.equal(f.syncer.isBusy, false);
                assert.equal(f.writes.length, side === "local" ? 1 : 0);
                if (syncIntervalMs) {
                    const beforeNextPoll = f.reads();
                    context.mock.timers.tick(interval);
                    await f.syncer.waitUntilFinished();
                    assert.equal(
                        f.reads(),
                        beforeNextPoll + 1,
                        "Polling stopped after its first successful run"
                    );
                    assert.equal(
                        f.writes.length,
                        side === "local" ? 1 : 0,
                        "An idle poll resubmitted unchanged content"
                    );
                }
                await f.syncer.stop();
                const stoppedReads = f.reads();
                context.mock.timers.tick(60_000);
                await f.syncer.waitUntilFinished();
                assert.equal(
                    f.reads(),
                    stoppedReads,
                    "Polling continued after stop"
                );
            } finally {
                await f.syncer.stop();
                context.mock.timers.reset();
            }
        });
    }
}

test("transient failures retry with polling disabled, then leave the client idle", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = await fixture(0);
    try {
        f.changeRemote();
        f.failNextRead();
        f.syncer.start();
        await assert.rejects(f.syncer.waitUntilFinished(), /offline/);
        const reads = f.reads();
        context.mock.timers.tick(retryInterval - 1);
        await assert.rejects(f.syncer.waitUntilFinished(), /offline/);
        assert.equal(f.reads(), reads);
        context.mock.timers.tick(1);
        await f.syncer.waitUntilFinished();
        assert.equal(f.reads(), reads + 1);
        assert.deepEqual(
            f.disk.userFiles(),
            new Map([["renamed.bin", bytes("remote edit")]])
        );
        assert.equal(f.database.state.lastSeenUpdateId, 4);
        assert.equal(f.syncer.isBusy, false);
        context.mock.timers.tick(60_000);
        await f.syncer.waitUntilFinished();
        assert.equal(
            f.reads(),
            reads + 1,
            "Network retries became clean-state polling"
        );
    } finally {
        await f.syncer.stop();
        context.mock.timers.reset();
    }
});

test("a failed WebSocket connection catches up over HTTP even when polling is disabled", async () => {
    const f = await fixture(0);
    try {
        f.syncer.start();
        await f.syncer.waitUntilFinished();
        f.changeRemote();
        f.websocket.onWebSocketStatusChanged.trigger(false);
        await f.syncer.waitUntilFinished();
        assert.equal(f.database.state.lastSeenUpdateId, 4);
        assert.deepEqual(
            f.disk.userFiles(),
            new Map([["renamed.bin", bytes("remote edit")]])
        );
    } finally {
        await f.syncer.stop();
    }
});
