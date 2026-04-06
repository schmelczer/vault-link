import { describe, it } from "node:test";
import assert from "node:assert";
import { SyncEventQueue } from "./sync-event-queue";
import { Settings } from "../persistence/settings";
import { Logger } from "../tracing/logger";
import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";
import { SyncEventType } from "./types";

function createQueue(ignorePatterns: string[] = []): SyncEventQueue {
    const logger = new Logger();
    const settings = new Settings(logger, { ignorePatterns }, async () => {});
    return new SyncEventQueue(settings, logger, undefined, async () => {});
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
    it("sync-local followed by delete for the same document returns only the delete", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });

        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A" });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A" });
        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
            path: "a.md",
        });

        const event = queue.next();
        assert.strictEqual(event?.type, SyncEventType.Delete);
        if (event?.type === SyncEventType.Delete) {
            assert.strictEqual(event.documentId, "A");
        }
        assert.strictEqual(queue.next(), undefined);
    });

    it("sync-local events for the same document coalesce to one", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });

        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A" });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A" });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A" });

        const event = queue.next();
        assert.strictEqual(event?.type, SyncEventType.SyncLocal);
        assert.strictEqual(queue.next(), undefined);
    });

    it("sync-remote events for the same documentId coalesce to the last one", () => {
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

        const event = queue.next();
        assert.strictEqual(event?.type, SyncEventType.SyncRemote);
        if (event?.type === SyncEventType.SyncRemote) {
            assert.strictEqual(event.remoteVersion.vaultUpdateId, 3);
        }
        assert.strictEqual(queue.next(), undefined);
    });

    it("create events are returned FIFO", () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.Create, path: "a.md" });
        queue.enqueue({ type: SyncEventType.Create, path: "b.md" });

        const first = queue.next();
        assert.strictEqual(first?.type, SyncEventType.Create);
        if (first?.type === SyncEventType.Create) {
            assert.strictEqual(first.path, "a.md");
        }

        const second = queue.next();
        assert.strictEqual(second?.type, SyncEventType.Create);
        if (second?.type === SyncEventType.Create) {
            assert.strictEqual(second.path, "b.md");
        }
    });

    it("duplicate creates for the same path are skipped", () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.Create, path: "a.md" });
        queue.enqueue({ type: SyncEventType.Create, path: "a.md" });
        assert.strictEqual(queue.size, 1);
    });

    it("create is skipped if the path already has a tracked document", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });

        queue.enqueue({ type: SyncEventType.Create, path: "a.md" });
        assert.strictEqual(queue.size, 0);
    });

    it("delete uses the provided documentId", () => {
        const queue = createQueue();

        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
            path: "a.md",
        });

        const event = queue.next();
        assert.strictEqual(event?.type, SyncEventType.Delete);
        if (event?.type === SyncEventType.Delete) {
            assert.strictEqual(event.documentId, "A");
        }
    });

    it("updateCreatePath updates the path of a create event in the queue", () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.Create, path: "old.md" });

        const updated = queue.updateCreatePath("old.md", "new.md");
        assert.strictEqual(updated, true);
        assert.strictEqual(queue.hasCreateEvent("old.md"), false);
        assert.strictEqual(queue.hasCreateEvent("new.md"), true);

        const event = queue.next();
        assert.strictEqual(event?.type, SyncEventType.Create);
        if (event?.type === SyncEventType.Create) {
            assert.strictEqual(event.path, "new.md");
        }
    });

    it("updateCreatePath returns false when no create event exists", () => {
        const queue = createQueue();
        const updated = queue.updateCreatePath("old.md", "new.md");
        assert.strictEqual(updated, false);
    });

    it("hasCreateEvent detects pending creates", () => {
        const queue = createQueue();
        assert.strictEqual(queue.hasCreateEvent("a.md"), false);

        queue.enqueue({ type: SyncEventType.Create, path: "a.md" });
        assert.strictEqual(queue.hasCreateEvent("a.md"), true);

        queue.next();
        assert.strictEqual(queue.hasCreateEvent("a.md"), false);
    });

    it("document store CRUD operations work correctly", () => {
        const queue = createQueue();

        assert.strictEqual(queue.getDocument("a.md"), undefined);
        assert.strictEqual(queue.documentCount, 0);

        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });
        assert.strictEqual(queue.documentCount, 1);
        assert.deepStrictEqual(queue.getDocument("a.md"), {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });

        const found = queue.getDocumentByDocumentId("A");
        assert.strictEqual(found?.path, "a.md");
        assert.strictEqual(found?.record.documentId, "A");

        queue.removeDocument("a.md");
        assert.strictEqual(queue.documentCount, 0);
        assert.strictEqual(queue.getDocument("a.md"), undefined);
    });

    it("moveDocument moves a document and returns displaced documentId", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });
        queue.setDocument("b.md", {
            documentId: "B",
            parentVersionId: 2,
            hash: "hash-b"
        });

        const displacedId = queue.moveDocument("a.md", "b.md");
        assert.strictEqual(displacedId, "B");
        assert.strictEqual(queue.getDocument("a.md"), undefined);
        assert.strictEqual(queue.getDocument("b.md")?.documentId, "A");
        assert.strictEqual(queue.documentCount, 1);
    });

    it("moveDocument returns undefined when target is unoccupied", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });

        const displacedId = queue.moveDocument("a.md", "b.md");
        assert.strictEqual(displacedId, undefined);
        assert.strictEqual(queue.getDocument("b.md")?.documentId, "A");
    });

    it("interleaved events for different documents are not confused", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });
        queue.setDocument("b.md", {
            documentId: "B",
            parentVersionId: 2,
            hash: "hash-b"
        });

        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A" });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "B" });
        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
            path: "a.md",
        });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "B" });

        // First next() should see the delete for A (coalescing sync-local + delete)
        const first = queue.next();
        assert.strictEqual(first?.type, SyncEventType.Delete);
        if (first?.type === SyncEventType.Delete) {
            assert.strictEqual(first.documentId, "A");
        }

        // Remaining should be the coalesced sync-local for B
        const second = queue.next();
        assert.strictEqual(second?.type, SyncEventType.SyncLocal);
        if (second?.type === SyncEventType.SyncLocal) {
            assert.strictEqual(second.documentId, "B");
        }

        assert.strictEqual(queue.next(), undefined);
    });

    it("delete discards subsequent sync-remote events for the same document", () => {
        const queue = createQueue();

        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
            path: "a.md",
        });
        queue.enqueue({
            type: SyncEventType.SyncRemote,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 5 })
        });

        const event = queue.next();
        assert.strictEqual(event?.type, SyncEventType.Delete);
        assert.strictEqual(queue.next(), undefined);
    });

    it("delete discards subsequent sync-local and sync-remote for the same document", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });

        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "A",
            path: "a.md",
        });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A" });
        queue.enqueue({ type: SyncEventType.Create, path: "b.md" });
        queue.enqueue({
            type: SyncEventType.SyncRemote,
            remoteVersion: fakeRemoteVersion("A", { vaultUpdateId: 5 })
        });

        const first = queue.next();
        assert.strictEqual(first?.type, SyncEventType.Delete);

        // Only the unrelated create should remain
        const second = queue.next();
        assert.strictEqual(second?.type, SyncEventType.Create);
        assert.strictEqual(queue.next(), undefined);
    });

    it("delete with empty documentId does not discard other events", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });

        queue.enqueue({
            type: SyncEventType.Delete,
            documentId: "",
            path: "unknown.md",
        });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A" });

        queue.next();
        const second = queue.next();
        assert.strictEqual(second?.type, SyncEventType.SyncLocal);
    });

    it("create can be re-enqueued after being dequeued", () => {
        const queue = createQueue();
        queue.enqueue({ type: SyncEventType.Create, path: "a.md" });
        queue.next();

        queue.enqueue({ type: SyncEventType.Create, path: "a.md" });
        assert.strictEqual(queue.size, 1);
    });

    it("silently ignores create events matching ignore patterns", () => {
        const queue = createQueue(["*.tmp", ".hidden/**"]);

        queue.enqueue({ type: SyncEventType.Create, path: "scratch.tmp" });
        queue.enqueue({
            type: SyncEventType.Create,
            path: ".hidden/secret.md",
        });
        assert.strictEqual(queue.size, 0);

        queue.enqueue({ type: SyncEventType.Create, path: "notes-new.md" });
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
            hash: "hash-a"
        });
        queue.enqueue({ type: SyncEventType.Create, path: "b.md" });
        queue.enqueue({ type: SyncEventType.SyncLocal, documentId: "A" });

        assert.strictEqual(queue.size, 2);

        queue.clear();

        assert.strictEqual(queue.size, 0);
        assert.strictEqual(queue.documentCount, 1);
        assert.strictEqual(queue.getDocument("a.md")?.documentId, "A");
    });

    it("allDocuments returns all tracked documents", () => {
        const queue = createQueue();
        queue.setDocument("a.md", {
            documentId: "A",
            parentVersionId: 1,
            hash: "hash-a"
        });
        queue.setDocument("b.md", {
            documentId: "B",
            parentVersionId: 2,
            hash: "hash-b"
        });

        const docs = queue.allDocuments();
        assert.strictEqual(docs.length, 2);
        const paths = docs.map(([p]) => p).sort();
        assert.deepStrictEqual(paths, ["a.md", "b.md"]);
    });

    it("loads initial state from persistence", () => {
        const logger = new Logger();
        const settings = new Settings(logger, {}, async () => {});
        const queue = new SyncEventQueue(settings, logger, {
            documents: [
                {
                    relativePath: "a.md",
                    documentId: "A",
                    parentVersionId: 5,
                    hash: "hash-a"
                },
                {
                    relativePath: "b.md",
                    documentId: "B",
                    parentVersionId: 3,
                    hash: "hash-b"
                }
            ],
            lastSeenUpdateId: 4
        }, async () => {});

        assert.strictEqual(queue.documentCount, 2);
        assert.strictEqual(queue.getDocument("a.md")?.documentId, "A");
        assert.strictEqual(queue.getDocument("b.md")?.documentId, "B");
        assert.strictEqual(queue.getLastSeenUpdateId(), 5);
    });
});
