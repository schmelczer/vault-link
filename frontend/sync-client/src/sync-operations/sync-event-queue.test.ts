import { describe, it } from "node:test";
import assert from "node:assert";
import { SyncEventQueue } from "./sync-event-queue";
import { Settings } from "../persistence/settings";
import { Logger } from "../tracing/logger";
import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";
import { SyncEventType } from "./types";

function createQueue(ignorePatterns: string[] = []): SyncEventQueue {
    const logger = new Logger();
    const settings = new Settings(logger, { ignorePatterns }, async () => { });
    return new SyncEventQueue(settings, logger, undefined, async () => { });
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
        ...overrides
    };
}

describe("SyncEventQueue", () => {
    it("sync-local followed by delete for the same document returns only the delete", async () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.LocalDelete);
        if (event?.type === SyncEventType.LocalDelete) {
            assert.strictEqual(event.documentId, "A");
        }
        assert.strictEqual(await queue.next(), undefined);
    });

    it("sync-local events for the same document coalesce to one", async () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "a.md" });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.LocalUpdate);
        assert.strictEqual(await queue.next(), undefined);
    });

    it("sync-remote-content events for the same documentId coalesce to the last one", async () => {
        const queue = createQueue();

        queue.enqueue({
            type: SyncEventType.RemoteChange,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 1 })
        });
        queue.enqueue({
            type: SyncEventType.RemoteChange,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 2 })
        });
        queue.enqueue({
            type: SyncEventType.RemoteChange,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 3 })
        });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.RemoteChange);
        if (event?.type === SyncEventType.RemoteChange) {
            assert.strictEqual(event.remoteVersion.vaultUpdateId, 3);
        }
        assert.strictEqual(await queue.next(), undefined);
    });

    it("create events are returned FIFO", async () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });

        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.LocalCreate);
        if (first?.type === SyncEventType.LocalCreate) {
            assert.strictEqual(first.path, "a.md");
        }

        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.LocalCreate);
        if (second?.type === SyncEventType.LocalCreate) {
            assert.strictEqual(second.path, "b.md");
        }
    });

    it("delete resolves documentId from path", async () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.LocalDelete);
        if (event?.type === SyncEventType.LocalDelete) {
            assert.strictEqual(event.documentId, "A");
        }
    });

    it("delete for unknown path is silently ignored", () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.LocalDelete, path: "unknown.md" });
        assert.strictEqual(queue.pendingUpdateCount, 0);
    });

    it("document store CRUD operations work correctly", () => {
        const queue = createQueue();

        assert.strictEqual(queue.getSettledDocumentByPath("a.md"), undefined);
        assert.strictEqual(queue.syncedDocumentCount, 0);

        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });
        assert.strictEqual(queue.syncedDocumentCount, 1);
        assert.deepStrictEqual(queue.getSettledDocumentByPath("a.md"), {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        const found = queue.getDocumentByDocumentId("A");
        assert.strictEqual(found?.path, "a.md");
        assert.strictEqual(found?.record.documentId, "A");

        queue.removeDocument("a.md");
        assert.strictEqual(queue.syncedDocumentCount, 0);
        assert.strictEqual(queue.getSettledDocumentByPath("a.md"), undefined);
    });

    it("SyncLocal with oldPath moves the document in the store", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "b.md", oldPath: "a.md" });
        assert.strictEqual(queue.getSettledDocumentByPath("a.md"), undefined);
        assert.strictEqual(queue.getSettledDocumentByPath("b.md")?.documentId, "A");
    });

    it("interleaved events for different documents are not confused", async () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });
        queue.setDocument("b.md", {
            documentId: "B",
            parentVersionId: 2,
            remoteHash: "hash-b"
        });

        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "b.md" });
        queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "b.md" });

        // First next() should see the delete for A (coalescing sync-local + delete)
        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.LocalDelete);
        if (first?.type === SyncEventType.LocalDelete) {
            assert.strictEqual(first.documentId, "A");
        }

        // Remaining should be the coalesced sync-local for B
        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.LocalUpdate);
        if (second?.type === SyncEventType.LocalUpdate) {
            assert.strictEqual(second.documentId, "B");
        }

        assert.strictEqual(await queue.next(), undefined);
    });

    it("delete discards subsequent sync-remote-content events for the same document", async () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });
        queue.enqueue({
            type: SyncEventType.RemoteChange,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 5 })
        });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.LocalDelete);
        assert.strictEqual(await queue.next(), undefined);
    });

    it("delete discards subsequent sync-local and sync-remote-content for the same document", async () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });
        queue.enqueue({
            type: SyncEventType.RemoteChange,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 5 })
        });

        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.LocalDelete);

        // Only the unrelated create should remain
        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.LocalCreate);
        assert.strictEqual(await queue.next(), undefined);
    });

    it("delete with promise documentId does not discard other events", async () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        // Create is pending — Delete for same path gets a promise documentId
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "unknown.md" });
        queue.enqueue({ type: SyncEventType.LocalDelete, path: "unknown.md" });
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "a.md" });

        // Dequeue and resolve the Create
        const event = await queue.next();
        assert.ok(event?.type === SyncEventType.LocalCreate);
        event.resolvers!.resolve("NEW");

        await queue.next(); // delete
        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.LocalUpdate);
    });

    it("getCreatePromise returns a promise resolved by the event's resolvers", async () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });

        const promise = queue.getLatestCreatePromise("a.md");
        assert.ok(promise !== undefined);

        // The syncer resolves via event.resolvers after dequeuing
        const event = await queue.next();
        assert.ok(event?.type === SyncEventType.LocalCreate);
        assert.ok(event.resolvers !== undefined);
        event.resolvers.resolve("resolved-id");

        assert.strictEqual(await promise, "resolved-id");
    });

    it("rejecting the event's resolvers rejects the create promise", async () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });

        const promise = queue.getLatestCreatePromise("a.md");
        assert.ok(promise !== undefined);

        const event = await queue.next();
        assert.ok(event?.type === SyncEventType.LocalCreate);
        assert.ok(event.resolvers !== undefined);
        event.resolvers.promise.catch(() => { });
        event.resolvers.reject(new Error("cancelled"));

        await assert.rejects(promise);
    });

    it("clear rejects all pending create promises", async () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });

        const promiseA = queue.getLatestCreatePromise("a.md");
        const promiseB = queue.getLatestCreatePromise("b.md");
        assert.ok(promiseA !== undefined);
        assert.ok(promiseB !== undefined);

        queue.clearPending();

        await assert.rejects(promiseA);
        await assert.rejects(promiseB);
    });

    it("create can be re-enqueued after being dequeued", async () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        await queue.next();

        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        assert.strictEqual(queue.pendingUpdateCount, 1);
    });

    it("silently ignores create events matching ignore patterns", () => {
        const queue = createQueue(["*.tmp", ".hidden/**"]);

        queue.enqueue({ type: SyncEventType.LocalCreate, path: "scratch.tmp" });
        queue.enqueue({ type: SyncEventType.LocalCreate, path: ".hidden/secret.md" });
        assert.strictEqual(queue.pendingUpdateCount, 0);

        queue.enqueue({ type: SyncEventType.LocalCreate, path: "notes-new.md" });
        assert.strictEqual(queue.pendingUpdateCount, 1);

        queue.enqueue({
            type: SyncEventType.RemoteChange,
            remoteVersion: fakeRemoteVersion("N")
        });
        assert.strictEqual(queue.pendingUpdateCount, 2);
    });

    it("clear removes events but keeps documents", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "a.md" });

        assert.strictEqual(queue.pendingUpdateCount, 2);

        queue.clearPending();

        assert.strictEqual(queue.pendingUpdateCount, 0);
        assert.strictEqual(queue.syncedDocumentCount, 1);
        assert.strictEqual(queue.getSettledDocumentByPath("a.md")?.documentId, "A");
    });

    it("allDocuments returns all tracked documents", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });
        queue.setDocument("b.md", {
            documentId: "B",
            parentVersionId: 2,
            remoteHash: "hash-b"
        });

        const docs = queue.allSettledDocuments();
        assert.strictEqual(docs.length, 2);
        const paths = docs.map(([p]) => p).sort();
        assert.deepStrictEqual(paths, ["a.md", "b.md"]);
    });

    it("loads initial state from persistence", () => {
        const logger = new Logger();
        const settings = new Settings(logger, {}, async () => { });
        const queue = new SyncEventQueue(settings, logger, {
            documents: [
                {
                    relativePath: "a.md",
                    documentId: "A",
                    parentVersionId: 5,
                    remoteHash: "hash-a"
                },
                {
                    relativePath: "b.md",
                    documentId: "B",
                    parentVersionId: 3,
                    remoteHash: "hash-b"
                }
            ],
            lastSeenUpdateId: 4
        }, async () => { });

        assert.strictEqual(queue.syncedDocumentCount, 2);
        assert.strictEqual(queue.getSettledDocumentByPath("a.md")?.documentId, "A");
        assert.strictEqual(queue.getSettledDocumentByPath("b.md")?.documentId, "B");
        assert.strictEqual(queue.lastSeenUpdateId, 5);
    });

    it("trackedPaths combines documents and pending events", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });
        queue.setDocument("b.md", {
            documentId: "B",
            parentVersionId: 2,
            remoteHash: "hash-b"
        });

        // Pending create adds a path
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "c.md" });
        // Pending delete removes a path
        queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        const paths = queue.trackedPaths();
        assert.deepStrictEqual(
            [...paths].sort(),
            ["b.md", "c.md"]
        );
    });

    it("trackedPaths handles create-delete-create for the same path", () => {
        const queue = createQueue();

        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        // Delete gets promise documentId from pending Create
        queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });

        const paths = queue.trackedPaths();
        assert.ok(paths.has("a.md"));
    });

    it("trackedPaths applies moves for pending SyncLocal events", () => {
        const queue = createQueue();

        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });

        // File was renamed from a.md to b.md
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "b.md", oldPath: "a.md" });

        const paths = queue.trackedPaths();
        assert.ok(!paths.has("a.md"));
        assert.ok(paths.has("b.md"));
    });

    it("trackedPaths tracks multiple moves for the same pending create", () => {
        const queue = createQueue();

        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });

        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "b.md", oldPath: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "c.md", oldPath: "b.md" });

        const paths = queue.trackedPaths();
        assert.ok(!paths.has("a.md"));
        assert.ok(!paths.has("b.md"));
        assert.ok(paths.has("c.md"));
    });

    it("resolveCreate settles the document and replaces promise documentIds in the queue", async () => {
        const queue = createQueue();

        queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        const createPromise = queue.getLatestCreatePromise("a.md")!;

        // Dependent events enqueued while create is still pending
        queue.enqueue({ type: SyncEventType.LocalUpdate, path: "a.md" });
        queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        const event = await queue.next(); // dequeue the create
        assert.ok(event?.type === SyncEventType.LocalCreate);

        queue.resolveCreate(event, {
            documentId: "DOC-1",
            parentVersionId: 5,
            remoteHash: "hash-1",
        });

        // Document is now settled
        assert.strictEqual(queue.getSettledDocumentByPath("a.md")?.documentId, "DOC-1");

        // Promise was resolved
        assert.strictEqual(await createPromise, "DOC-1");

        // Remaining events have string documentIds instead of promises.
        // The SyncLocal + Delete for "DOC-1" coalesce: sync-local is
        // discarded and the delete is returned (standard coalescing).
        const deleteEvt = await queue.next();
        assert.ok(deleteEvt?.type === SyncEventType.LocalDelete);
        assert.strictEqual(deleteEvt.documentId, "DOC-1");

        assert.strictEqual(await queue.next(), undefined);
    });
});
