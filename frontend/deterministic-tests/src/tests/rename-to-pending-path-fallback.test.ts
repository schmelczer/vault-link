import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: syncLocallyUpdatedFile does not handle pending doc at target path.
 *
 * In syncer.ts syncLocallyUpdatedFile (lines 146-195), the if/else chain:
 *   if (existingAtNew === undefined || existingAtNew.state === "deleted-locally")
 *   else if (existingAtNew.state === "tracked")
 *
 * There is NO branch for existingAtNew.state === "pending". When a tracked
 * doc is renamed to a path occupied by a pending create:
 *
 * 1. No branch matches → vfsMoveSucceeded stays false
 * 2. Falls back to local-update at oldPath
 * 3. File is on disk at newPath (user renamed it)
 * 4. Executor reads from oldPath → FileNotFoundError
 * 5. Operation is silently dropped
 * 6. Tracked doc at oldPath becomes orphaned (VFS entry, no file)
 * 7. On next reconciliation, recovers via filesystem scan
 *
 * This test verifies that the rename eventually converges, even though
 * the initial sync attempt fails. The pending doc at the target path
 * should be handled properly.
 */
function verifyFinalState(state: ClientState): void {
    // After convergence, A.md should exist with B's content (B was
    // renamed to A, overwriting the pending A). B.md should not exist.
    assert(
        state.files.has("A.md"),
        `Expected A.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        !state.files.has("B.md"),
        `Expected B.md to not exist (was renamed to A.md), got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const content = state.files.get("A.md") ?? "";
    assert(
        content.includes("tracked B content"),
        `Expected A.md to have B's content, got: "${content}"`
    );
}

export const renameToPendingPathFallbackTest: TestDefinition = {
    name: "Rename Tracked File to Path With Pending Create",
    description:
        "When a tracked document is renamed to a path occupied by a " +
        "pending create, the VFS move is skipped (no branch for pending " +
        "state). The fallback update fails with FileNotFoundError. " +
        "Reconciliation should eventually recover.",
    clients: 2,
    steps: [
        // Setup: B.md tracked and synced on both clients
        { type: "create", client: 0, path: "B.md", content: "tracked B content" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline
        { type: "disable-sync", client: 0 },

        // Client 0 creates A.md (pending, never synced)
        { type: "create", client: 0, path: "A.md", content: "pending A content" },

        // Client 0 renames B.md → A.md (overwrites the pending A)
        // This triggers the missing-branch bug
        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },

        // Re-enable sync
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Verify B.md is gone and A.md exists with B's content
        { type: "assert-not-exists", client: 0, path: "B.md" },
        { type: "assert-not-exists", client: 1, path: "B.md" },
        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
