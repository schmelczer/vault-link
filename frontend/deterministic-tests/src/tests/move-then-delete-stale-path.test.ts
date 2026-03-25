import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyDeleted(state: ClientState): void {
    const files = Array.from(state.files.keys());
    assert(
        state.files.size === 0,
        `Expected 0 files after move+delete, got ${state.files.size}: ${files.join(", ")}`
    );
}

/**
 * Tests the stale-path bug in the delete executor.
 *
 * When a file is renamed (A→B) and then deleted, the event coalescing
 * produces `move(A→B) + delete = delete(path: A)`. The VFS.move in
 * syncLocallyUpdatedFile has already moved the doc to B. The executor's
 * delete action looks up the doc: getByPath("A") returns undefined
 * (doc moved to B), so it falls back to getByDocumentId. It finds the
 * doc at B. Then it calls deleteLocally().
 *
 * Before the fix: deleteLocally(action.path) used "A" — the stale
 * path from when the event was enqueued. The pathIndex lookup at "A"
 * fails (doc is at "B"), so the delete is silently dropped. The doc
 * stays tracked at B, and the file is gone from disk but VFS thinks
 * it still exists.
 *
 * After the fix: deleteLocally(doc.relativePath) uses "B" — the
 * current VFS path. The delete succeeds.
 */
export const moveThenDeleteStalePathTest: TestDefinition = {
    name: "Move Then Delete (Stale Path Fix)",
    description:
        "Client 0 creates A.md, syncs. Then renames A.md to B.md and " +
        "immediately deletes B.md. The coalesced delete action has the " +
        "old path 'A', but the doc is at 'B' in VFS. The delete executor " +
        "must use the current VFS path, not the stale action path.",
    clients: 2,
    steps: [
        // Setup: create and sync
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
        {
            type: "assert-content",
            client: 1,
            path: "A.md",
            content: "content to delete"
        },

        // Rename A→B then delete B (with sync enabled so VFS.move fires)
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "delete", client: 0, path: "B.md" },

        { type: "sync" },
        { type: "barrier" },

        // Both clients should have 0 files
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 0, path: "B.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "B.md" },
        { type: "assert-consistent", verify: verifyDeleted }
    ]
};
