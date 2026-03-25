import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG FIX: Concurrent delete must not crash remote update processing.
 *
 * Scenario:
 * 1. Both clients have doc.md
 * 2. Client 0 updates doc.md (triggers remote-update on client 1)
 * 3. Client 1 deletes doc.md at the same time
 * 4. Client 1's remote update processing should not crash
 * 5. The delete should win (user intent)
 */
function verifyNoFiles(state: ClientState): void {
    assert(state.files.size === 0, `Expected 0 files, got ${state.files.size}`);
}

export const concurrentDeleteDuringRemoteUpdateTest: TestDefinition = {
    name: "Concurrent Delete During Remote Update Does Not Crash",
    description:
        "Deleting a file while a remote update is being processed " +
        "should not cause an unhandled exception.",
    clients: 2,
    steps: [
        // Setup
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Client 0 updates, client 1 deletes
        { type: "update", client: 0, path: "doc.md", content: "updated by 0" },
        { type: "delete", client: 1, path: "doc.md" },

        // Both come online — remote update and local delete race
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // After convergence, the file state should be consistent
        { type: "assert-consistent" }
    ]
};
