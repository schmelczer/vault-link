import { PushContentType } from "../services/protocol-types";
import { ContentSync, selectContentHead } from "./content-sync";
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import assert from "node:assert";
import { describe, it } from "node:test";
import type { Database, RelativePath } from "../persistence/database";
import { Settings } from "../persistence/settings";
import type { FileOperations } from "../file-operations/file-operations";
import type { SyncService } from "../services/sync-service";
import type { ServerConfig } from "../services/server-config";
import type { WebSocketManager } from "../services/websocket-manager";
import { Logger } from "../tracing/logger";
import type { SyncHistory } from "../tracing/sync-history";
import { EventListeners } from "../utils/data-structures/event-listeners";
import { Syncer } from "./syncer";
import { FixedSizeDocumentCache } from "../utils/data-structures/fix-sized-cache";
import { toHashedSnapshot } from "../snapshot";
import { undiff } from "reconcile-text";

describe("Syncer per-file state and event delivery", () => {
    const head = {
        vaultUpdateId: 1,
        documentId: "document",
        updatedDate: "2026-01-01T00:00:00Z",
        userId: "user",
        deviceId: "device",
        contentSize: 4
    };

    function fixture(): {
        database: Database;
        websocket: WebSocketManager;
        syncer: Syncer;
    } {
        const database = {
            state: {
                local: { document: "note.md" },
                documents: {
                    document: {
                        observedHash: "hash",
                        base: { ...head, hash: "hash" }
                    }
                },
                fileManifest: {
                    fileManifestId: 1,
                    entries: { document: "note.md" }
                },
                lastSeenUpdateId: 0
            },
            findDocumentId: (path: RelativePath) =>
                path === "note.md" ? "document" : undefined
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
                return { headEventId: 0, endEventId: 0, events: [] };
            }
        } as unknown as SyncService;
        const syncer = new Syncer(
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
            unsyncablePaths: Set<RelativePath>;
        };
        internals.unsyncablePaths.add("note.md");
        assert.strictEqual(syncer.isDocumentUpToDate("note.md"), false);
    });

    it("projects content responses to metadata before persistence", () => {
        const projected = selectContentHead({
            ...head,
            contentBase64: "secret"
        } as typeof head);
        assert.deepEqual(projected, {
            vaultUpdateId: head.vaultUpdateId,
            contentSize: head.contentSize
        });
        assert.strictEqual("contentBase64" in projected, false);
    });
});

describe("Syncer diff uploads", () => {
    const encoder = new TextEncoder();

    function fixture(cacheSize = 1024): {
        content: ContentSync;
        parent: Uint8Array;
    } {
        const cache = new FixedSizeDocumentCache(cacheSize);
        const parent = encoder.encode("one two three\n");
        const content = new ContentSync(
            { state: {} } as Database,
            new Settings(
                new Logger(),
                { syncIntervalMs: 0 },
                async () => undefined
            ),
            {
                getDocumentVersionContent: async () => parent
            } as unknown as SyncService,
            {} as FileOperations,
            {
                getConfig: async () => ({ mergeableFileExtensions: ["md"] })
            } as ServerConfig,
            cache
        );
        return { content, parent };
    }

    it("sends a diff when the fetched parent is still cached", async () => {
        const { content, parent } = fixture();
        await content.fetchSnapshot(
            { vaultUpdateId: 7, documentId: "document" },
            "note.md"
        );
        const changed = "one changed three\n";
        const payload = await content.createUploadPayload(
            "note.md",
            7,
            await toHashedSnapshot({ content: encoder.encode(changed) })
        );

        assert.equal(payload.type, "Diff");
        if (payload.type === PushContentType.Diff) {
            assert.equal(
                undiff(new TextDecoder().decode(parent), payload.value),
                changed
            );
        }
    });

    it("falls back to a snapshot when the parent cannot fit in the cache", async () => {
        const { content } = fixture(0);
        await content.fetchSnapshot(
            { vaultUpdateId: 7, documentId: "document" },
            "note.md"
        );
        const payload = await content.createUploadPayload(
            "note.md",
            7,
            await toHashedSnapshot({ content: encoder.encode("changed") })
        );

        assert.equal(payload.type, "Snapshot");
    });
});
