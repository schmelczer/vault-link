import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG FIX: When a create-merge returns an existing documentId, the stale
 * tracked record at a different path must NOT have its file deleted if the
 * file contains unsynchronized local modifications.
 *
 * Scenario (simplified from E2E log_4 failure):
 * 1. Both clients create "doc.md" → server merges → both have docX
 * 2. Client 1 goes offline, renames "doc.md" → "moved.md", updates it
 * 3. Client 1 also creates a new file at the OLD path "doc.md"
 * 4. Client 1 comes back online
 * 5. The update at "doc.md" sends new content to the server (overwriting docX)
 * 6. The create for "moved.md" may merge on the server
 * 7. The content appended in step 2 must still be present somewhere
 *
 * Previously, ensureUniqueDocumentId would delete the renamed file even
 * if it had unsynchronized local modifications, silently losing data.
 */
function verifyAllContentPreserved(state: ClientState): void {
    const allContent = [...state.files.values()].join("\n");
    assert(
        allContent.includes("extra-update"),
        `Expected "extra-update" to be preserved somewhere in the files, but got:\n${[...state.files.entries()].map(([k, v]) => `  ${k}: "${v}"`).join("\n")}`
    );
}

export const createMergePreservesRenamedUpdateTest: TestDefinition = {
    name: "Create-Merge Preserves Renamed File With Local Updates",
    description:
        "When a create request merges with an existing document, " +
        "a renamed copy of that document with unsynchronized updates " +
        "must not be deleted.",
    clients: 2,
    steps: [
        // Setup: both clients create at the same path → server merges
        { type: "create", client: 0, path: "doc.md", content: "alpha" },
        { type: "create", client: 1, path: "doc.md", content: "beta" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 1 goes offline and makes local changes
        { type: "disable-sync", client: 1 },

        // Rename the merged doc to a new path and update it
        {
            type: "rename",
            client: 1,
            oldPath: "doc.md",
            newPath: "moved.md"
        },
        {
            type: "update",
            client: 1,
            path: "moved.md",
            content: "alpha beta extra-update"
        },

        // Create a new file at the original path
        {
            type: "create",
            client: 1,
            path: "doc.md",
            content: "new-content"
        },

        // Come back online — the reconciliation will detect:
        // - "doc.md" in VFS (tracked) but with different content → update
        // - "moved.md" not in VFS → create
        // The create for "moved.md" may merge with the server's doc,
        // triggering ensureUniqueDocumentId
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Verify: "extra-update" must still exist in some file
        { type: "assert-consistent", verify: verifyAllContentPreserved }
    ]
};
