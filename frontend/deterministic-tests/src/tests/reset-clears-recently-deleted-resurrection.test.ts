import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: recentlyDeletedIds cleared on sync reset can allow document resurrection.
 *
 * Found by: multi-client convergence agent (#10)
 *
 * When the VFS is reset (syncer.ts line 225-229, on WebSocket disconnect),
 * the recentlyDeletedIds set is NOT cleared by syncer.reset() (which only
 * calls queue.reset()). The VFS.reset() DOES clear it (line 646), but
 * syncer.reset() doesn't call vfs.reset().
 *
 * However, there's a related edge case: if sync is toggled off and on
 * (which calls pause/resume), the recentlyDeletedIds persists correctly.
 * But if the client deletes a document and then loses connection, the
 * lastSeenUpdateId watermark may not have advanced past the delete.
 * On reconnect, the server replays the delete broadcast, and the client
 * should handle it correctly.
 *
 * This test verifies that after Client 0 deletes a file and Client 1
 * toggles sync off and on, the delete is properly applied and no
 * resurrection occurs.
 */
function verifyNoFiles(state: ClientState): void {
    assert(
        state.files.size === 0,
        `Expected 0 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
}

export const resetClearsRecentlyDeletedResurrectionTest: TestDefinition = {
    name: "Sync Reset Does Not Resurrect Deleted Documents",
    description:
        "Client 0 deletes a file. Client 1 toggles sync off and on " +
        "(simulating reconnect). The deleted file should NOT reappear " +
        "on Client 1 after the sync reset.",
    clients: 2,
    steps: [
        // Setup
        {
            type: "create",
            client: 0,
            path: "ghost.md",
            content: "should be deleted"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 deletes the file
        { type: "delete", client: 0, path: "ghost.md" },
        { type: "sync", client: 0 },

        // Wait for broadcast to propagate
        { type: "sync" },
        { type: "barrier" },

        // Client 1 should NOT have the file
        { type: "assert-not-exists", client: 1, path: "ghost.md" },

        // Client 1 toggles sync (simulating disconnect/reconnect)
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // File should STILL be gone — no resurrection
        { type: "assert-not-exists", client: 0, path: "ghost.md" },
        { type: "assert-not-exists", client: 1, path: "ghost.md" },
        { type: "assert-consistent", verify: verifyNoFiles }
    ]
};
