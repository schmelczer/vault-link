import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * EDGE CASE: File deleted locally while a create request is in-flight.
 *
 * The create request succeeds on the server, but by the time
 * applyServerResponse runs, the document has been removed from pathIndex
 * (deleted locally). The code at sync-actions.ts line 256-283 handles this:
 * it confirms the create (so the server has a documentId), then immediately
 * marks it as deleted-locally so the delete can be sent to the server.
 *
 * This test verifies that:
 * 1. The file is properly deleted on both clients
 * 2. No orphaned documents exist on the server
 * 3. No duplicate documentIds in the VFS
 */
function verifyNoFiles(state: ClientState): void {
    assert(
        state.files.size === 0,
        `Expected 0 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
}

export const deleteDuringPendingCreateTest: TestDefinition = {
    name: "Delete During Pending Create (Server Paused)",
    description:
        "Client creates a file, server is paused so the create request stalls. " +
        "Client then deletes the file while the create is in-flight. When the " +
        "server resumes, the create succeeds but the file should still end up " +
        "deleted on both clients.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Pause server so the create request stalls
        { type: "pause-server" },

        // Client 0 creates a file (HTTP request will stall)
        {
            type: "create",
            client: 0,
            path: "ephemeral.md",
            content: "this will be deleted"
        },

        // Wait a bit to ensure the create is queued

        // Client 0 deletes the file while create is pending
        { type: "delete", client: 0, path: "ephemeral.md" },

        // Resume server — the create request completes, then delete follows
        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        // File should be gone on both clients
        { type: "assert-not-exists", client: 0, path: "ephemeral.md" },
        { type: "assert-not-exists", client: 1, path: "ephemeral.md" },
        { type: "assert-consistent", verify: verifyNoFiles }
    ]
};
