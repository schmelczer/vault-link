import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Queue key migration can drop events when the new key already has events.
 *
 * In sync-event-queue.ts line 94-98, migrateKey() silently drops events
 * from the old key if the new key (documentId) already has queued events.
 * The comment says "Keep the existing state at the new key (it's more
 * recent)" — but the old key's state may contain unsynced local changes.
 *
 * Scenario:
 * 1. Client creates file A.md (pending, key = "path:A.md")
 * 2. Server assigns documentId via resolveIdempotencyKeys
 * 3. BEFORE the key migration, a local-update event for A.md arrives
 *    and gets queued under "path:A.md" (because the doc is still pending
 *    at that point in the resolveKey lookup)
 * 4. Meanwhile, a remote-update broadcast arrives for the same documentId
 *    and gets queued under the documentId key
 * 5. migrateKey runs: old key has "update", new key has "remote-update"
 * 6. The old key's "update" is DROPPED — the local edit is lost
 *
 * This test simulates a similar scenario: Client 0 creates a file and
 * immediately updates it. While the create is being resolved, the update
 * should not be lost.
 */
function verifyUpdatedContent(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("A.md"), "Expected A.md to exist");
    const content = state.files.get("A.md") ?? "";
    assert(
        content === "updated content",
        `Expected "updated content", got: "${content}"`
    );
}

export const keyMigrationEventDropTest: TestDefinition = {
    name: "Key Migration Does Not Drop Local Updates",
    description:
        "Client creates a file and immediately updates it before the create " +
        "is acknowledged. The queue key migrates from path-based to documentId. " +
        "The local update should not be lost during key migration.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Pause server so create request stalls
        { type: "pause-server" },

        // Client 0 creates file, then immediately updates it
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "initial content"
        },
        {
            type: "update",
            client: 0,
            path: "A.md",
            content: "updated content"
        },

        // Resume server — create completes, update should follow
        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        // The updated content should be on both clients, not the initial
        { type: "assert-consistent", verify: verifyUpdatedContent }
    ]
};
