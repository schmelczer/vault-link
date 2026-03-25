import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Renaming an empty file offline causes delete+create instead of move.
 *
 * In vfs.ts reconcileWithDisk (line 802-805):
 *   if (fileHash === undefined || fileHash === EMPTY_HASH) {
 *       remainingNew.push(path);
 *       continue;
 *   }
 *
 * Empty files (hash === EMPTY_HASH) are excluded from hash-based move
 * detection. When an empty file is renamed offline, the reconciliation
 * treats it as:
 *   - Old path: missing file → delete
 *   - New path: new file → create
 *
 * This loses the document's identity (gets a new documentId on the server).
 * The observable consequence is that the file appears as deleted+created
 * rather than renamed, and version history is lost.
 *
 * This test verifies that both clients converge after an empty file
 * rename. The file should exist at the new path on both clients.
 */
function verifyRenamedFile(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        !state.files.has("empty.md"),
        "empty.md should not exist (was renamed)"
    );
    assert(
        state.files.has("renamed.md"),
        "renamed.md should exist (renamed from empty.md)"
    );
    assert(
        state.files.get("renamed.md") === "",
        `Expected empty content, got: "${state.files.get("renamed.md")}"`
    );
}

export const renameEmptyFileLosesIdentityTest: TestDefinition = {
    name: "Rename Empty File Loses Document Identity",
    description:
        "When an empty file is renamed offline, the reconciliation cannot " +
        "detect it as a move (empty files are excluded from hash-based " +
        "move detection). This causes delete+create instead of move, " +
        "losing the document's server-side identity/history.",
    clients: 2,
    steps: [
        // Create and sync an empty file
        { type: "create", client: 0, path: "empty.md", content: "" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-exists", client: 1, path: "empty.md" },

        // Client 0 goes offline and renames
        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "empty.md", newPath: "renamed.md" },

        // Reconnect
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both should have only renamed.md
        { type: "assert-not-exists", client: 0, path: "empty.md" },
        { type: "assert-not-exists", client: 1, path: "empty.md" },
        { type: "assert-exists", client: 0, path: "renamed.md" },
        { type: "assert-exists", client: 1, path: "renamed.md" },
        { type: "assert-consistent", verify: verifyRenamedFile }
    ]
};
