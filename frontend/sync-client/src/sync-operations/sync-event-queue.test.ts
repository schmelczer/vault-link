import { describe, it } from "node:test";
import assert from "node:assert";
import { SyncEventQueue } from "./sync-event-queue";
import { Settings } from "../persistence/settings";
import { Logger } from "../tracing/logger";
import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";
import { SyncEventType } from "./types";
import type { DocumentRecord, RelativePath } from "./types";

function createQueue(ignorePatterns: string[] = []): SyncEventQueue {
    const logger = new Logger();
    const settings = new Settings(logger, { ignorePatterns }, async () => {
        /* no-op */
    });
    return new SyncEventQueue(settings, logger, undefined, async () => {
        /* no-op */
    });
}

function fakeRemoteVersion(
    documentId: string,
    overrides: Partial<DocumentVersionWithoutContent> = {}
): DocumentVersionWithoutContent {
    return {
        vaultUpdateId: 1,
        documentId,
        relativePath: `${documentId}.md`,
        updatedDate: "2026-01-01",
        isDeleted: false,
        userId: "user",
        deviceId: "device",
        contentSize: 100,
        isNewFile: true,
        ...overrides
    };
}

function fakeRecord(
    documentId: string,
    overrides: Partial<DocumentRecord> = {}
): DocumentRecord {
    return {
        path: `${documentId.toLowerCase()}.md`,
        documentId,
        parentVersionId: 1,
        remoteHash: `hash-${documentId}`,
        remoteRelativePath: `${documentId.toLowerCase()}.md`,
        ...overrides
    };
}

describe("SyncEventQueue", () => {
    it("returns enqueued events in FIFO order with no coalescing", async () => {
        const queue = createQueue();
        await queue.setDocument("a.md", fakeRecord("A"));

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "c.md" });
        await queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.LocalCreate);

        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.LocalCreate);

        const third = await queue.next();
        assert.strictEqual(third?.type, SyncEventType.LocalDelete);
        assert.strictEqual(third.documentId, "A");

        assert.strictEqual(await queue.next(), undefined);
    });

    it("create events are returned FIFO", async () => {
        const queue = createQueue();
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });

        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.LocalCreate);
        assert.strictEqual(first.path, "a.md");

        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.LocalCreate);
        assert.strictEqual(second.path, "b.md");
    });

    it("delete resolves documentId from path", async () => {
        const queue = createQueue();
        await queue.setDocument("a.md", fakeRecord("A"));

        await queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.LocalDelete);
        assert.strictEqual(event.documentId, "A");
    });

    it("delete for unknown path is silently ignored", async () => {
        const queue = createQueue();
        await queue.enqueue({
            type: SyncEventType.LocalDelete,
            path: "unknown.md"
        });
        assert.strictEqual(queue.pendingUpdateCount, 0);
    });

    it("document store CRUD operations work correctly", async () => {
        const queue = createQueue();

        assert.strictEqual(queue.getSettledDocumentByPath("a.md"), undefined);
        assert.strictEqual(queue.syncedDocumentCount, 0);

        await queue.setDocument("a.md", fakeRecord("A"));
        assert.strictEqual(queue.syncedDocumentCount, 1);
        assert.deepStrictEqual(
            queue.getSettledDocumentByPath("a.md"),
            fakeRecord("A")
        );

        const found = queue.getDocumentByDocumentId("A");
        assert.strictEqual(found?.path, "a.md");
        assert.strictEqual(found.documentId, "A");

        await queue.removeDocument("a.md");
        assert.strictEqual(queue.syncedDocumentCount, 0);
        assert.strictEqual(queue.getSettledDocumentByPath("a.md"), undefined);
    });

    it("SyncLocal with oldPath moves the document in the store", async () => {
        const queue = createQueue();
        await queue.setDocument("a.md", fakeRecord("A"));

        await queue.enqueue({
            type: SyncEventType.LocalUpdate,
            path: "b.md",
            oldPath: "a.md"
        });
        assert.strictEqual(queue.getSettledDocumentByPath("a.md"), undefined);
        assert.strictEqual(
            queue.getSettledDocumentByPath("b.md")?.documentId,
            "A"
        );
    });

    it("create can be re-enqueued after being dequeued", async () => {
        const queue = createQueue();
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        await queue.next();

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        assert.strictEqual(queue.pendingUpdateCount, 1);
    });

    it("silently ignores create events matching ignore patterns", async () => {
        const queue = createQueue(["*.tmp", ".hidden/**"]);

        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: "scratch.tmp"
        });
        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: ".hidden/secret.md"
        });
        assert.strictEqual(queue.pendingUpdateCount, 0);

        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: "notes-new.md"
        });
        assert.strictEqual(queue.pendingUpdateCount, 1);

        await queue.enqueue({
            type: SyncEventType.RemoteChange,
            remoteVersion: fakeRemoteVersion("N")
        });
        assert.strictEqual(queue.pendingUpdateCount, 2);
    });

    it("clearPending removes events but keeps documents", async () => {
        const queue = createQueue();
        await queue.setDocument("a.md", fakeRecord("A"));
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "c.md" });

        assert.strictEqual(queue.pendingUpdateCount, 2);

        queue.clearPending();

        assert.strictEqual(queue.pendingUpdateCount, 0);
        assert.strictEqual(queue.syncedDocumentCount, 1);
        assert.strictEqual(
            queue.getSettledDocumentByPath("a.md")?.documentId,
            "A"
        );
    });

    it("allSettledDocuments returns all tracked documents", async () => {
        const queue = createQueue();
        await queue.setDocument("a.md", fakeRecord("A"));
        await queue.setDocument("b.md", fakeRecord("B"));

        const docs = queue.allSettledDocuments();
        assert.strictEqual(docs.size, 2);
        const paths = Array.from(docs.keys()).sort();
        assert.deepStrictEqual(paths, ["a.md", "b.md"]);
    });

    it("loads initial state from persistence", () => {
        const logger = new Logger();
        const settings = new Settings(logger, {}, async () => {
            /* no-op */
        });
        const queue = new SyncEventQueue(
            settings,
            logger,
            {
                documents: [
                    fakeRecord("A", { path: "a.md", parentVersionId: 5 }),
                    fakeRecord("B", { path: "b.md", parentVersionId: 3 })
                ],
                lastSeenUpdateId: 4
            },
            async () => {
                /* no-op */
            }
        );

        assert.strictEqual(queue.syncedDocumentCount, 2);
        assert.strictEqual(
            queue.getSettledDocumentByPath("a.md")?.documentId,
            "A"
        );
        assert.strictEqual(
            queue.getSettledDocumentByPath("b.md")?.documentId,
            "B"
        );
        assert.strictEqual(queue.lastSeenUpdateId, 4);
    });

    it("resolveCreate settles the document and resolves the create promise", async () => {
        const queue = createQueue();

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });

        const event = await queue.next(); // dequeue the create
        assert.ok(event?.type === SyncEventType.LocalCreate);
        const createPromise = event.resolvers.promise;

        await queue.resolveCreate(
            event,
            fakeRecord("DOC-1", { parentVersionId: 5 })
        );

        // Document is now settled
        assert.strictEqual(
            queue.getSettledDocumentByPath("a.md")?.documentId,
            "DOC-1"
        );

        // Promise was resolved
        assert.strictEqual(await createPromise, "DOC-1");
    });

    it("findLatestCreateForPath returns the pending create", async () => {
        const queue = createQueue();

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });

        const found = queue.findLatestCreateForPath("a.md" as RelativePath);
        assert.ok(found !== undefined);
        assert.strictEqual(found.path, "a.md");

        const missing = queue.findLatestCreateForPath("c.md" as RelativePath);
        assert.strictEqual(missing, undefined);
    });

    it("hasPendingEventsForPath reflects pending events", async () => {
        const queue = createQueue();
        await queue.setDocument("a.md", fakeRecord("A"));

        assert.strictEqual(queue.hasPendingEventsForPath("a.md"), false);

        await queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });
        assert.strictEqual(queue.hasPendingEventsForPath("a.md"), true);
    });

    it("clearAllState clears everything", async () => {
        const queue = createQueue();
        await queue.setDocument("a.md", fakeRecord("A"));
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });

        await queue.clearAllState();

        assert.strictEqual(queue.syncedDocumentCount, 0);
        assert.strictEqual(queue.pendingUpdateCount, 0);
    });
});
