import { describe, it } from "node:test";
import assert from "node:assert";
import { Logger } from "../tracing/logger";
import { Settings } from "../persistence/settings";
import { STORED_STATE_SCHEMA_VERSION, SyncEventQueue } from "./sync-event-queue";
import { scheduleOfflineChanges } from "./offline-change-detector";
import type { FileOperations } from "../file-operations/file-operations";
import type { RelativePath } from "./types";

const makeQueue = async (): Promise<SyncEventQueue> => {
    const logger = new Logger();
    const settings = new Settings(logger, {}, async () => {
        /* no-op */
    });
    return new SyncEventQueue(
        settings,
        logger,
        { schemaVersion: STORED_STATE_SCHEMA_VERSION },
        async () => {
            /* no-op */
        }
    );
};

const makeOperations = (
    files: Record<string, Uint8Array>
): FileOperations => {
    return {
        listFilesRecursively: async () => Object.keys(files),
        read: async (path: RelativePath) => {
            const data = files[path];
            if (data === undefined) {
                throw new Error(`File not found: ${path}`);
            }
            return data;
        }
    } as unknown as FileOperations;
};

describe("scheduleOfflineChanges", () => {
    it("does not bind a local file to a placement-pending record whose remoteRelativePath was persisted before the doc moved on the server", async () => {
        // The bug: persisted byDocId can carry a placement-pending record
        // whose `remoteRelativePath` was saved before the doc was moved
        // server-side. After restart, offline-scan running before WS
        // catch-up would bind an unrelated local file at that stale path
        // to the moved doc and push the user's content as an update —
        // silently corrupting the moved doc and stranding the local file.
        const queue = await makeQueue();

        // Stale placement-pending record: server has moved this doc
        // away from "stale-X.md" since this snapshot was saved.
        await queue.upsertRecord({
            documentId: "MOVED-DOC",
            parentVersionId: 5,
            remoteRelativePath: "stale-X.md" as RelativePath,
            remoteHash: "hash-from-old-state",
            localPath: undefined
        });

        // User has an unrelated local file at the stale path.
        const operations = makeOperations({
            "stale-X.md": new TextEncoder().encode(
                "user's unrelated local content"
            )
        });

        const enqueued: { kind: string; path: string }[] = [];
        await scheduleOfflineChanges(
            new Logger(),
            operations,
            queue,
            (path) => enqueued.push({ kind: "create", path }),
            (args) => enqueued.push({ kind: "update", path: args.relativePath }),
            (path) => enqueued.push({ kind: "delete", path })
        );

        // The local file must become a fresh CREATE — never a hostile
        // UPDATE on the moved doc.
        assert.deepStrictEqual(enqueued, [
            { kind: "create", path: "stale-X.md" }
        ]);

        // The placement-pending record must remain placement-pending —
        // its localPath must not have been bound to the unrelated user
        // file. The reconciler will place it correctly once WS catch-up
        // updates `remoteRelativePath` to the doc's current location.
        const record = queue.getDocumentByDocumentId("MOVED-DOC");
        assert.notStrictEqual(record, undefined);
        assert.strictEqual(record?.localPath, undefined);
    });

    it("schedules an update for a local file that matches a settled record's localPath", async () => {
        const queue = await makeQueue();
        await queue.upsertRecord({
            documentId: "SETTLED-DOC",
            parentVersionId: 2,
            remoteRelativePath: "doc.md" as RelativePath,
            remoteHash: "hash",
            localPath: "doc.md" as RelativePath
        });

        const operations = makeOperations({
            "doc.md": new TextEncoder().encode("content")
        });

        const enqueued: { kind: string; path: string }[] = [];
        await scheduleOfflineChanges(
            new Logger(),
            operations,
            queue,
            (path) => enqueued.push({ kind: "create", path }),
            (args) => enqueued.push({ kind: "update", path: args.relativePath }),
            (path) => enqueued.push({ kind: "delete", path })
        );

        assert.deepStrictEqual(enqueued, [
            { kind: "update", path: "doc.md" }
        ]);
    });

    it("schedules a delete for a settled record whose local file is missing", async () => {
        const queue = await makeQueue();
        await queue.upsertRecord({
            documentId: "VANISHED-DOC",
            parentVersionId: 4,
            remoteRelativePath: "gone.md" as RelativePath,
            remoteHash: "hash",
            localPath: "gone.md" as RelativePath
        });

        const operations = makeOperations({});

        const enqueued: { kind: string; path: string }[] = [];
        await scheduleOfflineChanges(
            new Logger(),
            operations,
            queue,
            (path) => enqueued.push({ kind: "create", path }),
            (args) => enqueued.push({ kind: "update", path: args.relativePath }),
            (path) => enqueued.push({ kind: "delete", path })
        );

        assert.deepStrictEqual(enqueued, [
            { kind: "delete", path: "gone.md" }
        ]);
    });

    it("detects an offline rename when an untracked file matches a deleted record's content hash", async () => {
        const queue = await makeQueue();
        const content = new TextEncoder().encode("body");
        const contentHash = await (await import("../utils/hash")).hash(content);

        await queue.upsertRecord({
            documentId: "DOC-1",
            parentVersionId: 5,
            remoteRelativePath: "old.md" as RelativePath,
            remoteHash: contentHash,
            localPath: "old.md" as RelativePath
        });
        const operations = makeOperations({ "new.md": content });

        const enqueued: {
            kind: string;
            path: string;
            oldPath?: string;
        }[] = [];
        await scheduleOfflineChanges(
            new Logger(),
            operations,
            queue,
            (path) => enqueued.push({ kind: "create", path }),
            (args) =>
                enqueued.push({
                    kind: "update",
                    path: args.relativePath,
                    oldPath: args.oldPath
                }),
            (path) => enqueued.push({ kind: "delete", path })
        );

        assert.deepStrictEqual(enqueued, [
            { kind: "update", path: "new.md", oldPath: "old.md" }
        ]);
    });
});
