import assert from "node:assert/strict";
import { test } from "node:test";
import {
    Database,
    emptyState,
    type StoredDatabase
} from "../sync-client/src/persistence/database";
import { Settings } from "../sync-client/src/persistence/settings";
import { FileOperations } from "../sync-client/src/file-operations/file-operations";
import type { ServerConfig } from "../sync-client/src/services/server-config";
import type { SyncService } from "../sync-client/src/services/sync-service";
import type { WebSocketManager } from "../sync-client/src/services/websocket-manager";
import type { EventBatch } from "../sync-client/src/services/types/EventBatch";
import type { EventRecord } from "../sync-client/src/services/types/EventRecord";
import { Syncer } from "../sync-client/src/sync-operations/syncer";
import { Logger } from "../sync-client/src/tracing/logger";
import { SyncHistory } from "../sync-client/src/tracing/sync-history";
import { EventListeners } from "../sync-client/src/utils/data-structures/event-listeners";
import { FixedSizeDocumentCache } from "../sync-client/src/utils/data-structures/fix-sized-cache";
import { MemoryDisk, MemoryPersistence } from "./storage";

for (const [count, delivery] of [
    [1, "before the loop"],
    [9, "before the loop"],
    [3, "during the first batch"]
] as const) {
    test(
        `${count} WS hints delivered ${delivery} catch up through HTTP without polling`,
        { timeout: 5_000 },
        async () => {
            const logger = new Logger();
            const initial = emptyState("event-delivery");
            initial.initialized = true;
            const persistence = new MemoryPersistence({ database: initial });
            const database = new Database(
                initial,
                async (next) => persistence.save({ database: next }),
                initial.vaultKey,
                async () =>
                    (await persistence.load()).database as StoredDatabase
            );
            const settings = new Settings(
                logger,
                { syncIntervalMs: 0 },
                async () => {}
            );
            assert.equal(settings.getSettings().syncIntervalMs, 0);
            const disk = new MemoryDisk();
            const initializing = Promise.withResolvers<void>();
            const initialized = Promise.withResolvers<void>();
            const firstBatch = Promise.withResolvers<void>();
            const continueBatch = Promise.withResolvers<void>();
            let heldBatch = false;
            const applied: number[] = [];
            persistence.boundary = async (label) => {
                if (label !== "durable:save") return;
                const cursor =
                    persistence.snapshot().database!.lastSeenUpdateId;
                if (cursor && applied.at(-1) !== cursor) applied.push(cursor);
                if (
                    delivery === "during the first batch" &&
                    cursor === 1 &&
                    !heldBatch
                ) {
                    heldBatch = true;
                    firstBatch.resolve();
                    await continueBatch.promise;
                }
            };
            const config = {
                initialize: async () => {
                    initializing.resolve();
                    await initialized.promise;
                },
                getConfig: async () => ({ mergeableFileExtensions: ["md"] }),
                reset: () => {}
            } as unknown as ServerConfig;
            const events: EventRecord[] = Array.from(
                { length: count },
                (_, index) => ({
                    eventId: index + 1,
                    requestId: `manifest-${index + 1}`,
                    type: "fileManifest",
                    fileManifest: { fileManifestId: index + 1, entries: {} }
                })
            );
            let available: number = delivery === "before the loop" ? count : 1;
            const fetchedAfter: number[] = [];
            const service = {
                events: async (after: number): Promise<EventBatch> => {
                    fetchedAfter.push(after);
                    return {
                        headEventId: available,
                        events: events.filter(
                            (event) =>
                                event.eventId > after &&
                                event.eventId <= available
                        )
                    };
                }
            } as unknown as SyncService;
            const websocket = {
                onWebSocketStatusChanged: new EventListeners<
                    (connected: boolean) => unknown
                >(),
                onRemoteVaultUpdateReceived: new EventListeners<
                    (batch: EventBatch) => unknown
                >()
            };
            const syncer = new Syncer(
                "device",
                logger,
                database,
                settings,
                service,
                websocket as unknown as WebSocketManager,
                new FileOperations(disk.session(), database, config),
                config,
                new SyncHistory(logger),
                new FixedSizeDocumentCache(1024)
            );
            const deliver = async (event: EventRecord) => {
                await websocket.onRemoteVaultUpdateReceived.triggerAsync({
                    headEventId: event.eventId,
                    // Payloads are deliberately inconsistent with HTTP. The socket
                    // only wakes the loop; it cannot supply reconciliation state.
                    events: [
                        {
                            ...event,
                            type: "fileManifest",
                            fileManifest: { fileManifestId: 999, entries: {} }
                        }
                    ]
                });
            };
            try {
                syncer.start();
                await initializing.promise;
                if (delivery === "before the loop") {
                    for (const event of events) await deliver(event);
                    initialized.resolve();
                } else {
                    await deliver(events[0]);
                    initialized.resolve();
                    await firstBatch.promise;
                    available = count;
                    for (const event of events.slice(1)) await deliver(event);
                    continueBatch.resolve();
                }
                await syncer.waitUntilFinished();
                assert.equal(
                    database.state.lastSeenUpdateId,
                    count,
                    "Client became idle with already-delivered events unapplied"
                );
                assert.deepEqual(
                    applied,
                    delivery === "before the loop" ? [count] : [1, count],
                    "Each HTTP catchup commits its final cursor"
                );
                assert.deepEqual(
                    fetchedAfter,
                    delivery === "before the loop" ? [0] : [0, 1]
                );
                assert.equal(database.state.fileManifest.fileManifestId, count);
                assert.equal(database.state.pending, undefined);
                assert.equal(syncer.isBusy, false);
            } finally {
                initialized.resolve();
                continueBatch.resolve();
                await syncer.stop();
            }
        }
    );
}
