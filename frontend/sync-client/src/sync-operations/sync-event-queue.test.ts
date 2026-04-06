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

        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A", path: "a.md", originalPath: "a.md" });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A", path: "a.md", originalPath: "a.md" });
        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
        });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.Delete);
        if (event?.type === SyncEventType.Delete) {
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

        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A", path: "a.md", originalPath: "a.md" });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A", path: "a.md", originalPath: "a.md" });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A", path: "a.md", originalPath: "a.md" });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.SyncLocal);
        assert.strictEqual(await queue.next(), undefined);
    });

    it("sync-remote events for the same documentId coalesce to the last one", async () => {
        const queue = createQueue();

        queue.enqueue({
            type: SyncEventType.SyncRemote,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 1 })
        });
        queue.enqueue({
            type: SyncEventType.SyncRemote,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 2 })
        });
        queue.enqueue({
            type: SyncEventType.SyncRemote,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 3 })
        });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.SyncRemote);
        if (event?.type === SyncEventType.SyncRemote) {
            assert.strictEqual(event.remoteVersion.vaultUpdateId, 3);
        }
        assert.strictEqual(await queue.next(), undefined);
    });

    it("create events are returned FIFO", async () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });
        queue.enqueue({ type: SyncEventType.Create, path: "b.md", originalPath: "b.md" });

        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.Create);
        if (first?.type === SyncEventType.Create) {
            assert.strictEqual(first.path, "a.md");
        }

        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.Create);
        if (second?.type === SyncEventType.Create) {
            assert.strictEqual(second.path, "b.md");
        }
    });

    it("delete uses the provided documentId", async () => {
        const queue = createQueue();

        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
        });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.Delete);
        if (event?.type === SyncEventType.Delete) {
            assert.strictEqual(event.documentId, "A");
        }
    });

    it("document store CRUD operations work correctly", () => {
        const queue = createQueue();

        assert.strictEqual(queue.getSettledDocumentByPath("a.md"), undefined);
        assert.strictEqual(queue.documentCount, 0);

        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });
        assert.strictEqual(queue.documentCount, 1);
        assert.deepStrictEqual(queue.getSettledDocumentByPath("a.md"), {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        const found = queue.getDocumentByDocumentId("A");
        assert.strictEqual(found?.path, "a.md");
        assert.strictEqual(found?.record.documentId, "A");

        queue.removeDocument("a.md");
        assert.strictEqual(queue.documentCount, 0);
        assert.strictEqual(queue.getSettledDocumentByPath("a.md"), undefined);
    });

    it("moveDocument moves a document and returns displaced documentId", () => {
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

        const displacedId = queue.moveDocument("a.md", "b.md");
        assert.strictEqual(displacedId, "B");
        assert.strictEqual(queue.getSettledDocumentByPath("a.md"), undefined);
        assert.strictEqual(queue.getSettledDocumentByPath("b.md")?.documentId, "A");
        assert.strictEqual(queue.documentCount, 1);
    });

    it("moveDocument returns undefined when target is unoccupied", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        const displacedId = queue.moveDocument("a.md", "b.md");
        assert.strictEqual(displacedId, undefined);
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

        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A", path: "a.md", originalPath: "a.md" });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "B", path: "b.md", originalPath: "b.md" });
        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
        });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "B", path: "b.md", originalPath: "b.md" });

        // First next() should see the delete for A (coalescing sync-local + delete)
        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.Delete);
        if (first?.type === SyncEventType.Delete) {
            assert.strictEqual(first.documentId, "A");
        }

        // Remaining should be the coalesced sync-local for B
        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.SyncLocal);
        if (second?.type === SyncEventType.SyncLocal) {
            assert.strictEqual(second.documentId, "B");
        }

        assert.strictEqual(await queue.next(), undefined);
    });

    it("delete discards subsequent sync-remote events for the same document", async () => {
        const queue = createQueue();

        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
        });
        queue.enqueue({
            type: SyncEventType.SyncRemote,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 5 })
        });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.Delete);
        assert.strictEqual(await queue.next(), undefined);
    });

    it("delete discards subsequent sync-local and sync-remote for the same document", async () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
        });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A", path: "a.md", originalPath: "a.md" });
        queue.enqueue({ type: SyncEventType.Create, path: "b.md", originalPath: "b.md" });
        queue.enqueue({
            type: SyncEventType.SyncRemote,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 5 })
        });

        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.Delete);

        // Only the unrelated create should remain
        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.Create);
        assert.strictEqual(await queue.next(), undefined);
    });

    it("delete with promise documentId does not discard other events", async () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });

        queue.enqueue({ type: SyncEventType.Create, path: "unknown.md", originalPath: "unknown.md" });
        const createPromise = queue.getCreatePromise("unknown.md");
        assert.ok(createPromise !== undefined);
        const event = await queue.next(); // dequeue the create
        assert.ok(event?.type === SyncEventType.Create);
        // Resolve so the delete's await doesn't hang
        event.resolvers!.resolve("NEW");

        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: createPromise,
        });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A", path: "a.md", originalPath: "a.md" });

        await queue.next(); // delete
        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.SyncLocal);
    });

    it("getCreatePromise returns a promise resolved by the event's resolvers", async () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });

        const promise = queue.getCreatePromise("a.md");
        assert.ok(promise !== undefined);

        // The syncer resolves via event.resolvers after dequeuing
        const event = await queue.next();
        assert.ok(event?.type === SyncEventType.Create);
        assert.ok(event.resolvers !== undefined);
        event.resolvers.resolve("resolved-id");

        assert.strictEqual(await promise, "resolved-id");
    });

    it("rejecting the event's resolvers rejects the create promise", async () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });

        const promise = queue.getCreatePromise("a.md");
        assert.ok(promise !== undefined);

        const event = await queue.next();
        assert.ok(event?.type === SyncEventType.Create);
        assert.ok(event.resolvers !== undefined);
        event.resolvers.promise.catch(() => { });
        event.resolvers.reject(new Error("cancelled"));

        await assert.rejects(promise);
    });

    it("clear rejects all pending create promises", async () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });
        queue.enqueue({ type: SyncEventType.Create, path: "b.md", originalPath: "b.md" });

        const promiseA = queue.getCreatePromise("a.md");
        const promiseB = queue.getCreatePromise("b.md");
        assert.ok(promiseA !== undefined);
        assert.ok(promiseB !== undefined);

        queue.clear();

        await assert.rejects(promiseA);
        await assert.rejects(promiseB);
    });

    it("create can be re-enqueued after being dequeued", async () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });
        await queue.next();

        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });
        assert.strictEqual(queue.size, 1);
    });

    it("silently ignores create events matching ignore patterns", () => {
        const queue = createQueue(["*.tmp", ".hidden/**"]);

        queue.enqueue({ type: SyncEventType.Create, path: "scratch.tmp", originalPath: "scratch.tmp" });
        queue.enqueue({
            type: SyncEventType.Create,
            path: ".hidden/secret.md",
            originalPath: ".hidden/secret.md",
        });
        assert.strictEqual(queue.size, 0);

        queue.enqueue({ type: SyncEventType.Create, path: "notes-new.md", originalPath: "notes-new.md" });
        assert.strictEqual(queue.size, 1);

        queue.enqueue({
            type: SyncEventType.SyncRemote,
            remoteVersion: fakeRemoteVersion("N")
        });
        assert.strictEqual(queue.size, 2);
    });

    it("clear removes events but keeps documents", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            remoteHash: "hash-a"
        });
        queue.enqueue({ type: SyncEventType.Create, path: "b.md", originalPath: "b.md" });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A", path: "a.md", originalPath: "a.md" });

        assert.strictEqual(queue.size, 2);

        queue.clear();

        assert.strictEqual(queue.size, 0);
        assert.strictEqual(queue.documentCount, 1);
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

        assert.strictEqual(queue.documentCount, 2);
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
        queue.enqueue({ type: SyncEventType.Create, path: "c.md", originalPath: "c.md" });
        // Pending delete removes a path
        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
        });

        const paths = queue.trackedPaths();
        assert.deepStrictEqual(
            [...paths].sort(),
            ["b.md", "c.md"]
        );
    });

    it("trackedPaths handles create-delete-create for the same path", () => {
        const queue = createQueue();

        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });
        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: Promise.resolve("X"),
        });
        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });

        const paths = queue.trackedPaths();
        assert.ok(paths.has("a.md"));
    });

    it("trackedPaths applies moves for promise-based SyncLocal events", () => {
        const queue = createQueue();

        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });
        const createPromise = queue.getCreatePromise("a.md")!;

        // File was renamed from a.md to b.md
        queue.enqueue({
            type: SyncEventType.SyncLocal,
            documentId: createPromise,
            path: "b.md",
            originalPath: "a.md",
        });

        const paths = queue.trackedPaths();
        assert.ok(!paths.has("a.md"));
        assert.ok(paths.has("b.md"));
    });

    it("trackedPaths tracks multiple moves for the same pending create", () => {
        const queue = createQueue();

        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });
        const createPromise = queue.getCreatePromise("a.md")!;

        queue.enqueue({
            type: SyncEventType.SyncLocal,
            documentId: createPromise,
            path: "b.md",
            originalPath: "a.md",
        });
        queue.enqueue({
            type: SyncEventType.SyncLocal,
            documentId: createPromise,
            path: "c.md",
            originalPath: "a.md",
        });

        const paths = queue.trackedPaths();
        assert.ok(!paths.has("a.md"));
        assert.ok(!paths.has("b.md"));
        assert.ok(paths.has("c.md"));
    });

    it("resolveCreate settles the document and replaces promise documentIds in the queue", async () => {
        const queue = createQueue();

        queue.enqueue({ type: SyncEventType.Create, path: "a.md", originalPath: "a.md" });
        const createPromise = queue.getCreatePromise("a.md")!;

        // Dependent events enqueued while create is in flight
        queue.enqueue({
            type: SyncEventType.SyncLocal,
            documentId: createPromise,
            path: "a.md",
            originalPath: "a.md",
        });
        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: createPromise,
        });

        const event = await queue.next(); // dequeue the create
        assert.ok(event?.type === SyncEventType.Create);

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
        assert.ok(deleteEvt?.type === SyncEventType.Delete);
        assert.strictEqual(deleteEvt.documentId, "DOC-1");

        assert.strictEqual(await queue.next(), undefined);
    });
});
