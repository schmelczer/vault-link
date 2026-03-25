import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Move detection fails when two files have identical content.
 *
 * reconcileWithDisk() detects moves by matching content hashes of new files
 * against missing tracked docs. If there are TWO missing tracked docs with
 * the same hash, neither will match (matches.length !== 1), and the move
 * is treated as a "new file + delete" instead of a rename.
 *
 * Scenario:
 * 1. Client 0 creates two files with identical content: A.md and B.md
 * 2. Both sync to Client 1
 * 3. Client 1 goes offline
 * 4. Client 1 deletes A.md and renames B.md to C.md (same content)
 * 5. Client 1 reconnects
 *
 * Expected: A.md deleted on server, B.md renamed to C.md (preserving documentId)
 * Bug: reconcileWithDisk sees B.md missing + C.md new, but content hash
 * matches BOTH A.md and B.md (since they had identical content). So the
 * move from B→C is not detected. Instead, B.md is treated as a delete
 * and C.md as a new create, losing B.md's documentId.
 *
 * The test verifies convergence still works (the system recovers via
 * server-side merge), but documents may get new documentIds unnecessarily.
 */
function verifyFinalState(state: ClientState): void {
    // A.md should not exist (deleted)
    assert(!state.files.has("A.md"), "A.md should not exist");

    // B.md should not exist (renamed to C.md)
    assert(!state.files.has("B.md"), "B.md should not exist");

    // C.md should exist with the shared content
    assert(state.files.has("C.md"), "C.md should exist");
    const content = state.files.get("C.md") ?? "";
    assert(
        content === "identical content",
        `Expected C.md to contain "identical content", got: "${content}"`
    );

    // Only C.md should exist
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
}

export const moveIdenticalContentAmbiguityTest: TestDefinition = {
    name: "Move Detection Ambiguity With Identical Content",
    description:
        "Two files with identical content exist. One is deleted and the other " +
        "renamed while offline. On reconnect, the move detection algorithm sees " +
        "two matching hashes and cannot determine which missing doc was moved. " +
        "The system should still converge correctly.",
    clients: 2,
    steps: [
        // Setup: create two files with identical content
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "identical content"
        },
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "identical content"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Verify both clients have both files
        {
            type: "assert-content",
            client: 1,
            path: "A.md",
            content: "identical content"
        },
        {
            type: "assert-content",
            client: 1,
            path: "B.md",
            content: "identical content"
        },

        // Client 1 goes offline, deletes A.md and renames B.md → C.md
        { type: "disable-sync", client: 1 },
        { type: "delete", client: 1, path: "A.md" },
        { type: "rename", client: 1, oldPath: "B.md", newPath: "C.md" },

        // Client 1 reconnects
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should converge
        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
