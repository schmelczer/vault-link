/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { Database } from "../persistence/database";
import {
    DEFAULT_SETTINGS,
    Settings,
    type SyncSettings
} from "../persistence/settings";
import type { FileOperations } from "../file-operations/file-operations";
import type { SyncService } from "../services/sync-service";
import type { ServerConfig } from "../services/server-config";
import type { WebSocketManager } from "../services/websocket-manager";
import { Logger } from "../tracing/logger";
import type { SyncHistory } from "../tracing/sync-history";
import { EventListeners } from "../utils/data-structures/event-listeners";
import { Syncer } from "./syncer";
import { FixedSizeDocumentCache } from "../utils/data-structures/fix-sized-cache";
import { toStoredSnapshot } from "./content";
import { undiff } from "reconcile-text";

function createSyncer(overrides: Partial<SyncSettings> = {}): {
    syncer: Syncer;
    runCount: () => number;
} {
    const settings = new Settings(
        new Logger(),
        overrides,
        async () => undefined
    );
    const database = {
        state: {}
    } as unknown as Database;
    const websocket = {
        onWebSocketStatusChanged: new EventListeners<
            (connected: boolean) => unknown
        >(),
        onRemoteVaultUpdateReceived: new EventListeners<() => unknown>()
    } as unknown as WebSocketManager;
    const syncer = new Syncer(
        "device",
        {} as Logger,
        database,
        settings,
        {} as SyncService,
        websocket,
        {} as FileOperations,
        {} as ServerConfig,
        {} as SyncHistory,
        new FixedSizeDocumentCache(1024)
    );
    let runs = 0;
    const internals = syncer as unknown as {
        dirty: boolean;
        run: () => Promise<void>;
    };
    internals.run = async (): Promise<void> => {
        runs++;
        internals.dirty = false;
    };

    return { syncer, runCount: () => runs };
}

describe("Syncer interval", () => {
    beforeEach(() => {
        mock.timers.enable({ apis: ["setTimeout"] });
    });

    afterEach(() => {
        mock.timers.reset();
    });

    it("does not schedule a timer when syncIntervalMs is unset", async () => {
        const { syncer, runCount } = createSyncer({
            syncIntervalMs: undefined
        });

        syncer.start();
        await syncer.waitUntilFinished();
        mock.timers.tick(60_000);

        assert.strictEqual(runCount(), 1);
        await syncer.stop();
    });

    it("keeps periodic reconciliation opt-in by default", async () => {
        assert.strictEqual(DEFAULT_SETTINGS.syncIntervalMs, undefined);
        const { syncer, runCount } = createSyncer();
        syncer.start();
        await syncer.waitUntilFinished();
        mock.timers.tick(60_000);
        assert.strictEqual(runCount(), 1);
        await syncer.stop();
    });

    it("does not poll when explicitly disabled with zero", async () => {
        const { syncer, runCount } = createSyncer({ syncIntervalMs: 0 });
        syncer.start();
        await syncer.waitUntilFinished();
        mock.timers.tick(60_000);
        assert.strictEqual(runCount(), 1);
        await syncer.stop();
    });

    it("wakes after the configured sync interval", async () => {
        const { syncer, runCount } = createSyncer({ syncIntervalMs: 25 });

        syncer.start();
        await syncer.waitUntilFinished();
        mock.timers.tick(24);
        assert.strictEqual(runCount(), 1);

        mock.timers.tick(1);
        assert.strictEqual(runCount(), 2);
        await syncer.waitUntilFinished();
        await syncer.stop();
    });
});

describe("Syncer per-file state and event delivery", () => {
    const head = {
        vaultUpdateId: 1,
        documentId: "document",
        updatedDate: "2026-01-01T00:00:00Z",
        userId: "user",
        deviceId: "device",
        contentSize: 4
    };

    function fixture() {
        const database = {
            state: {
                initialized: true,
                local: { document: "note.md" },
                documents: {
                    document: {
                        materialized: true,
                        observedHash: "hash",
                        base: { ...head, hash: "hash" }
                    }
                },
                fileManifest: {
                    fileManifestId: 1,
                    entries: { document: "note.md" }
                },
                remoteHeads: { document: head },
                lastSeenUpdateId: 0
            },
            getLatestDocumentByRelativePath: (path: string) =>
                path === "note.md"
                    ? {
                          documentId: "document",
                          relativePath: path
                      }
                    : undefined
        } as unknown as Database;
        const websocket = {
            onWebSocketStatusChanged: new EventListeners<
                (connected: boolean) => unknown
            >(),
            onRemoteVaultUpdateReceived: new EventListeners<
                () => Promise<void>
            >()
        } as unknown as WebSocketManager;
        const service = {
            events: async () => {
                return { headEventId: 0, events: [] };
            }
        } as unknown as SyncService;
        const syncer = new Syncer(
            "device",
            {} as Logger,
            database,
            new Settings(
                new Logger(),
                { syncIntervalMs: 0 },
                async () => undefined
            ),
            service,
            websocket,
            {} as FileOperations,
            {} as ServerConfig,
            {} as SyncHistory,
            new FixedSizeDocumentCache(1024)
        );
        (syncer as unknown as { hasScanned: boolean }).hasScanned = true;
        return {
            database,
            websocket,
            syncer
        };
    }

    it("reports only a genuinely current path as up to date", () => {
        const { syncer } = fixture();
        assert.strictEqual(syncer.isDocumentUpToDate("note.md"), true);
        assert.strictEqual(syncer.isDocumentUpToDate("missing.md"), false);

        const internals = syncer as unknown as {
            dirty: boolean;
            unsyncablePaths: Set<string>;
        };
        internals.dirty = true;
        assert.strictEqual(syncer.isDocumentUpToDate("note.md"), true);
        internals.unsyncablePaths.add("note.md");
        assert.strictEqual(syncer.isDocumentUpToDate("note.md"), false);
    });

    it("projects content responses to metadata before persistence", () => {
        const { syncer } = fixture();
        const projected = (
            syncer as unknown as {
                documentHead: (value: typeof head) => Record<string, unknown>;
            }
        ).documentHead({ ...head, contentBase64: "secret" } as typeof head);
        assert.deepEqual(projected, head);
        assert.strictEqual("contentBase64" in projected, false);
    });
});

describe("Syncer diff uploads", () => {
    const encoder = new TextEncoder();

    function fixture(cacheSize = 1024): {
        syncer: Syncer;
        parent: Uint8Array;
    } {
        const cache = new FixedSizeDocumentCache(cacheSize);
        const parent = encoder.encode("one two three\n");
        const websocket = {
            onWebSocketStatusChanged: new EventListeners<
                (connected: boolean) => unknown
            >(),
            onRemoteVaultUpdateReceived: new EventListeners<() => unknown>()
        } as unknown as WebSocketManager;
        const syncer = new Syncer(
            "device",
            {} as Logger,
            { state: {} } as Database,
            new Settings(
                new Logger(),
                { syncIntervalMs: 0 },
                async () => undefined
            ),
            {
                getDocumentVersionContent: async () => parent
            } as unknown as SyncService,
            websocket,
            {} as FileOperations,
            {
                getConfig: async () => ({ mergeableFileExtensions: ["md"] })
            } as ServerConfig,
            {} as SyncHistory,
            cache
        );
        return { syncer, parent };
    }

    it("sends a diff when the fetched parent is still cached", async () => {
        const { syncer, parent } = fixture();
        const internals = syncer as unknown as {
            remoteSnapshot: (
                head: {
                    vaultUpdateId: number;
                    documentId: string;
                },
                path: string
            ) => Promise<unknown>;
            pushContent: (
                path: string,
                parentVersionId: number,
                snapshot: Awaited<ReturnType<typeof toStoredSnapshot>>
            ) => Promise<
                | { type: "Diff"; value: (number | string)[] }
                | { type: "Snapshot"; value: string }
            >;
        };
        await internals.remoteSnapshot(
            { vaultUpdateId: 7, documentId: "document" },
            "note.md"
        );
        const changed = "one changed three\n";
        const payload = await internals.pushContent(
            "note.md",
            7,
            await toStoredSnapshot({ content: encoder.encode(changed) })
        );

        assert.equal(payload.type, "Diff");
        if (payload.type === "Diff") {
            assert.equal(
                undiff(new TextDecoder().decode(parent), payload.value),
                changed
            );
        }
    });

    it("falls back to a snapshot when the parent cannot fit in the cache", async () => {
        const { syncer } = fixture(0);
        const internals = syncer as unknown as {
            remoteSnapshot: (
                head: {
                    vaultUpdateId: number;
                    documentId: string;
                },
                path: string
            ) => Promise<unknown>;
            pushContent: (
                path: string,
                parentVersionId: number,
                snapshot: Awaited<ReturnType<typeof toStoredSnapshot>>
            ) => Promise<{ type: string; value: unknown }>;
        };
        await internals.remoteSnapshot(
            { vaultUpdateId: 7, documentId: "document" },
            "note.md"
        );
        const payload = await internals.pushContent(
            "note.md",
            7,
            await toStoredSnapshot({ content: encoder.encode("changed") })
        );

        assert.equal(payload.type, "Snapshot");
    });
});
