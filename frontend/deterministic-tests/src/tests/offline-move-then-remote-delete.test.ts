import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Move + remote-delete coalescing uses stale source path.
 *
 * Found by: multi-client convergence agent (#10)
 *
 * When a local move and a remote-delete are coalesced for the same document:
 *   move(A→B) + remote-delete = delete(path: A)
 * (sync-events.ts line 210-211)
 *
 * But the VFS has already moved the document from A to B (syncer.ts
 * line 152 runs vfs.move() immediately on the local-move event).
 * When the executor tries to find the document at path A (line 302
 * in syncer.ts), it returns undefined because D1 is now at path B.
 * The delete is silently skipped.
 *
 * The system should recover via runFinalConsistencyCheck() or the next
 * reconciliation cycle, which will detect that B.md exists on disk
 * but the server says D1 is deleted.
 *
 * This test verifies that both clients converge — the file should end
 * up deleted on both clients.
 */
function verifyNoFiles(state: ClientState): void {
    assert(
        state.files.size === 0,
        `Expected 0 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
}

export const offlineMoveThenRemoteDeleteTest: TestDefinition = {
    name: "Offline Move + Remote Delete Convergence",
    description:
        "Client 0 renames A→B offline while Client 1 deletes A. " +
        "The move+delete coalescing may use a stale path. " +
        "Both clients should converge to having no files.",
    clients: 2,
    steps: [
        // Setup: both have A.md
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "content to delete"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline, renames A→B
        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },

        // Client 1 deletes A.md (broadcasts to server)
        { type: "delete", client: 1, path: "A.md" },
        { type: "sync", client: 1 },

        // Client 0 reconnects — receives remote-delete while move is pending
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both should converge to no files
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-not-exists", client: 0, path: "B.md" },
        { type: "assert-not-exists", client: 1, path: "B.md" },
        { type: "assert-consistent", verify: verifyNoFiles }
    ]
};
