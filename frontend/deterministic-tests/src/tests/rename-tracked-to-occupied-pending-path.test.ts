import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyResult(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();
    // The rename of B.md to A.md overwrites A.md on disk. The pending
    // create's content ("first file at A") is lost because the user
    // chose to overwrite it. VFS.move fails (A.md occupied by pending
    // create), so the fallback enqueues an update for B.md which fails
    // (FileNotFoundError — B.md no longer exists on disk).
    //
    // After reconciliation: A.md's pending create reads the overwritten
    // content ("tracked file B") from disk, and B.md is deleted
    // (missing from disk).
    //
    // Result: A.md with "tracked file B" content.
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${files.join(", ")}`
    );
    assert(
        state.files.has("A.md"),
        `Expected A.md to exist. Files: ${files.join(", ")}`
    );
    const content = state.files.get("A.md") ?? "";
    assert(
        content === "tracked file B",
        `Expected A.md to have "tracked file B", got: "${content}"`
    );
}

/**
 * BUG: Tests VFS.move failure when renaming a tracked file to a path
 * occupied by a pending create. In syncer.ts, VFS.move is attempted
 * but fails if the target path is occupied by a non-deleted-locally
 * document. The move event falls back to an update at oldPath.
 *
 * When the user renames B.md to A.md, the filesystem overwrites A.md.
 * The pending create's original content is lost from disk. After sync,
 * only A.md survives with B.md's content.
 */
export const renameTrackedToOccupiedPendingPathTest: TestDefinition = {
    name: "Rename Tracked File to Path Occupied by Pending Create",
    description:
        "Client creates A.md (pending, sync disabled) then renames B.md " +
        "(tracked) to A.md. VFS.move should fail because A.md is occupied " +
        "by the pending create. The rename overwrites A.md on disk, so " +
        "only A.md survives with B.md's content.",
    clients: 2,
    steps: [
        // Setup: create B.md and sync it (becomes tracked)
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "tracked file B"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "B.md",
            content: "tracked file B"
        },

        // Disable sync on Client 0
        { type: "disable-sync", client: 0 },

        // Create A.md (pending — sync disabled, not yet synced)
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "first file at A"
        },

        // Try to rename tracked B.md to A.md (occupied by pending)
        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },

        // Re-enable sync — after reconciliation, A.md survives
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // A.md exists with B.md's content (rename overwrite)
        { type: "assert-consistent", verify: verifyResult }
    ]
};
