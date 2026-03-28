import { describe, it } from "node:test";
import assert from "node:assert";
import { SyncEventQueue, type SyncEvent } from "./sync-event-queue";

describe("SyncEventQueue", () => {
    it("delete collapses interleaved events for one document while leaving the other intact", () => {
        const queue = new SyncEventQueue();
        queue.enqueue({ type: "local-content-update", documentId: "A" });
        queue.enqueue({ type: "remote-content-update", documentId: "B" });
        queue.enqueue({ type: "local-content-update", documentId: "A" });
        queue.enqueue({ type: "move", documentId: "A" });
        queue.enqueue({ type: "remote-content-update", documentId: "A" });
        queue.enqueue({ type: "delete", documentId: "A" });
        queue.enqueue({ type: "local-content-update", documentId: "B" });

        assert.deepStrictEqual(queue.next(), { type: "delete", documentId: "A" });
        assert.deepStrictEqual(queue.next(), {
            type: "local-content-update",
            documentId: "B"
        });
        assert.strictEqual(queue.next(), undefined);
    });

    it("updates coalesce up to a move boundary then post-move events are processed separately", () => {
        const queue = new SyncEventQueue();
        queue.enqueue({ type: "local-content-update", documentId: "X" });
        queue.enqueue({ type: "remote-content-update", documentId: "X" });
        queue.enqueue({ type: "file-create", path: "new.md" });
        queue.enqueue({ type: "local-content-update", documentId: "X" });
        queue.enqueue({ type: "move", documentId: "X" });
        queue.enqueue({ type: "remote-content-update", documentId: "X" });
        queue.enqueue({ type: "local-content-update", documentId: "X" });

        assert.deepStrictEqual(queue.next(), {
            type: "local-content-update",
            documentId: "X"
        });
        assert.deepStrictEqual(queue.next(), { type: "file-create", path: "new.md" });
        assert.deepStrictEqual(queue.next(), { type: "move", documentId: "X" });
        assert.deepStrictEqual(queue.next(), {
            type: "local-content-update",
            documentId: "X"
        });
        assert.strictEqual(queue.next(), undefined);
    });
});
