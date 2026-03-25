import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG FIX TEST: Interrupted deletes must be retried after reconnect.
 *
 * Scenario:
 * 1. Client 0 creates a file, syncs to both clients.
 * 2. Client 0 deletes the file.
 * 3. Server is paused BEFORE the delete HTTP request completes.
 *    The doc transitions to deleted-locally but the server never receives the delete.
 * 4. Server resumes. Client reconnects and runs reconciliation.
 * 5. The interrupted delete should be retried and succeed.
 * 6. Both clients should converge on 0 files.
 */
function verifyNoFiles(state: ClientState): void {
    assert(state.files.size === 0, `Expected 0 files, got ${state.files.size}: ${[...state.files.keys()].join(", ")}`);
}

export const interruptedDeleteRetryTest: TestDefinition = {
    name: "Interrupted Delete Is Retried After Reconnect",
    description:
        "A delete that was interrupted by a server pause/disconnect " +
        "should be retried when the connection is restored.",
    clients: 2,
    steps: [
        // Setup: create file, sync both
        { type: "create", client: 0, path: "doc.md", content: "to be deleted" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 deletes the file
        { type: "delete", client: 0, path: "doc.md" },

        // Pause server to interrupt the delete request
        { type: "pause-server" },

        // Resume server - the interrupted delete should be retried
        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should have 0 files
        { type: "assert-consistent", verify: verifyNoFiles },
    ],
};
