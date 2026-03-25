import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * EDGE CASE: Delete and immediately recreate at the same path with
 * different content, while the other client is editing.
 *
 * This exercises the coalescing path: delete + create = create.
 * But the tricky part is that the ORIGINAL document at this path
 * was tracked (had a documentId). The delete marks it as deleted-locally.
 * The subsequent create makes a NEW pending document at the same path.
 *
 * Meanwhile, Client 1 has been editing the same file. When both sync:
 * - Client 0's delete should go through first
 * - Client 0's create creates a NEW document on the server
 * - Client 1's edit to the OLD document may conflict
 *
 * The coalescing turns delete+create into just "create". But the executor
 * for "create" at sync-actions.ts line 247 checks the VFS: if a tracked
 * doc exists at the path, it treats the create as an update instead.
 * Since the delete was coalesced away, the tracked doc STILL exists
 * in the VFS at the time of execution → the "create" is treated as an
 * update to the existing document, not a new document.
 *
 * This might be correct (updates the existing doc with new content) or
 * might be a bug (should create a new documentId). The test verifies
 * convergence either way.
 */
function verifyFinalState(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(state.files.has("A.md"), "Expected A.md to exist");
    const content = state.files.get("A.md") ?? "";
    // Both client contents should be merged (empty-parent 3-way merge)
    assert(
        content.includes("brand new content") &&
            content.includes("edit from client 1"),
        `Expected merged content with both edits, got: "${content}"`
    );
}

export const deleteRecreateDifferentContentTest: TestDefinition = {
    name: "Delete + Recreate Same Path While Other Client Edits",
    description:
        "Client 0 deletes and recreates A.md with new content while " +
        "Client 1 edits A.md. The coalesced delete+create should produce " +
        "correct behavior and both clients should converge.",
    clients: 2,
    steps: [
        // Setup: create A.md
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "original content here"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Client 0: delete and recreate with new content
        { type: "delete", client: 0, path: "A.md" },
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "brand new content"
        },

        // Client 1: edit the same file
        {
            type: "update",
            client: 1,
            path: "A.md",
            content: "edit from client 1"
        },

        // Reconnect both
        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
