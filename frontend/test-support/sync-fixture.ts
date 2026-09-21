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
import { globsToRegexes } from "../sync-client/src/utils/globs-to-regexes";
import type { ServerConfig } from "../sync-client/src/services/server-config";
import type { SyncService } from "../sync-client/src/services/sync-service";
import type { WebSocketManager } from "../sync-client/src/services/websocket-manager";
import { MemoryDisk, MemoryPersistence } from "./storage";
import type { LocalChange } from "../sync-client/src/sync-operations/local-changes";

export const bytes = (text: string) => new TextEncoder().encode(text);
export const head = (id: string, version: number, content: string) => ({
    documentId: id,
    vaultUpdateId: version,
    contentSize: bytes(content).length,
    updatedDate: "2026-09-19T00:00:00Z",
    userId: "user",
    deviceId: "device"
});

export async function fixture(
    contents: Record<string, string> = { "a.md": "local" },
    service: Partial<SyncService> = {},
    recovered?: { disk: MemoryDisk; persistence: MemoryPersistence }
) {
    const disk = recovered?.disk ?? new MemoryDisk();
    const initial = recovered
        ? (recovered.persistence.snapshot().database as StoredDatabase)
        : emptyState("test");
    if (!recovered) {
        initial.initialized = true;
        for (const [path, content] of Object.entries(contents)) {
            await disk.userWrite(path, bytes(content));
            const id = path.split(".")[0];
            initial.local[id] = path;
            initial.documents[id] = {
                materialized: true,
                observedHash: (
                    await toStoredSnapshot({ content: bytes(content) })
                ).hash
            };
        }
        initial.fileManifest = {
            fileManifestId: 1,
            entries: { ...initial.local }
        };
    }
    const persistence =
        recovered?.persistence ?? new MemoryPersistence({ database: initial });
    const logger = new Logger();
    const database = new Database(
        initial,
        async (next) => persistence.save({ database: next }),
        "test",
        async () => (await persistence.load()).database as StoredDatabase
    );
    const config = {
        initialize: async () => {},
        getConfig: async () => ({ mergeableFileExtensions: ["md"] }),
        reset: () => {}
    } as unknown as ServerConfig;
    const settings = new Settings(
        logger,
        { syncIntervalMs: 0 },
        async () => {}
    );
    const changes: LocalChange[] = [];
    const files = new FileOperations(
        disk.session(),
        database,
        config,
        undefined,
        { entries: () => changes, flush: async () => {} },
        (path, size) =>
            size > settings.getSettings().maxFileSizeMB * 1024 * 1024 ||
            globsToRegexes(settings.getSettings().ignorePatterns, logger).some(
                (pattern) => pattern.test(path)
            )
    );
    const websocket = {
        onWebSocketStatusChanged: new EventListeners(),
        onRemoteVaultUpdateReceived: new EventListeners()
    } as unknown as WebSocketManager;
    const contentCache = new FixedSizeDocumentCache(1024);
    const syncer = new Syncer(
        "device",
        logger,
        database,
        settings,
        service as SyncService,
        websocket,
        files,
        config,
        new SyncHistory(logger),
        contentCache,
        { entries: changes, save: async () => {} }
    );
    const internals = syncer as unknown as {
        finishPending: () => Promise<void>;
        preparePush: () => Promise<boolean>;
        scan: (
            initial?: import("../sync-client/src/services/types/VaultSnapshot").VaultSnapshot
        ) => Promise<void>;
        incorporateEventBatch: (
            batch: import("../sync-client/src/services/types/EventBatch").EventBatch
        ) => Promise<void>;
        stopped: boolean;
        incorporateFileManifest: (remote: {
            fileManifestId: number;
            entries: Record<string, string>;
        }) => Promise<void>;
        incorporateContent: (remote: ReturnType<typeof head>) => Promise<void>;
    };
    return {
        disk,
        database,
        files,
        settings,
        syncer,
        internals,
        persistence,
        changes,
        contentCache
    };
}
