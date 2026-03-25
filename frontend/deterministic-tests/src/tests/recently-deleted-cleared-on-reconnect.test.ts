import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG FIX: recentlyDeletedIds must be cleared on reconnect.
 *
 * Scenario:
 * 1. Client 0 creates and syncs doc.md
 * 2. Client 0 deletes doc.md (adds to recentlyDeletedIds)
 * 3. Client 0 goes offline
 * 4. Client 1 creates a NEW doc.md (different documentId)
 * 5. Client 0 comes online
 * 6. Client 0 should receive the new doc.md from client 1
 *    (recentlyDeletedIds should have been cleared on reconnect so
 *    the new documentId is not blocked)
 */
function verifyFileExists(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("doc.md"), "Expected doc.md to exist");
    const content = state.files.get("doc.md") ?? "";
    assert(
        content === "new content from client 1",
        `Expected "new content from client 1", got: "${content}"`
    );
}

export const recentlyDeletedClearedOnReconnectTest: TestDefinition = {
    name: "Recently Deleted IDs Cleared On Reconnect",
    description:
        "After a client deletes a document and reconnects, it should " +
        "accept new documents from other clients even if they happen to " +
        "arrive at the same path as the deleted document.",
    clients: 2,
    steps: [
        // Setup: both online
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 creates and syncs a file
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 deletes the file
        { type: "delete", client: 0, path: "doc.md" },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline
        { type: "disable-sync", client: 0 },

        // Client 1 creates a new file at the same path
        { type: "create", client: 1, path: "doc.md", content: "new content from client 1" },
        { type: "sync", client: 1 },

        // Client 0 comes back online - should receive the new file
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyFileExists },
    ],
};
