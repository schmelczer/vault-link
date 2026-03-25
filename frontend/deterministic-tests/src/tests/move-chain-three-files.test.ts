import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * EDGE CASE: Three-file circular rotation while offline.
 *
 * Files A, B, C get rotated: A→B, B→C, C→A. Since the DeterministicAgent
 * works on an in-memory filesystem, we can simulate this by:
 * 1. Delete all three files
 * 2. Recreate them with rotated content
 *
 * On reconnect, the reconciliation algorithm must detect that:
 * - A.md has C's old content (move from C→A)
 * - B.md has A's old content (move from A→B)
 * - C.md has B's old content (move from B→C)
 *
 * Since each file has unique content, the hash-based move detection should
 * work. But this creates THREE simultaneous move detections, which is a
 * stress test of the algorithm: each match removes from missingTracked,
 * and the order of processing matters.
 */
function verifyFinalState(state: ClientState): void {
    assert(
        state.files.size === 3,
        `Expected 3 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.get("A.md") === "was C",
        `Expected A.md = "was C", got: "${state.files.get("A.md")}"`
    );
    assert(
        state.files.get("B.md") === "was A",
        `Expected B.md = "was A", got: "${state.files.get("B.md")}"`
    );
    assert(
        state.files.get("C.md") === "was B",
        `Expected C.md = "was B", got: "${state.files.get("C.md")}"`
    );
}

export const moveChainThreeFilesTest: TestDefinition = {
    name: "Three-File Circular Rotation Offline",
    description:
        "Three files are rotated (A→B, B→C, C→A) while offline by " +
        "deleting all and recreating with swapped content. The reconciliation " +
        "should detect the moves via hash matching and sync correctly.",
    clients: 2,
    steps: [
        // Setup: create three files with unique content
        { type: "create", client: 0, path: "A.md", content: "was A" },
        { type: "create", client: 0, path: "B.md", content: "was B" },
        { type: "create", client: 0, path: "C.md", content: "was C" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline
        { type: "disable-sync", client: 0 },

        // Delete all three
        { type: "delete", client: 0, path: "A.md" },
        { type: "delete", client: 0, path: "B.md" },
        { type: "delete", client: 0, path: "C.md" },

        // Recreate with rotated content: C→A, A→B, B→C
        { type: "create", client: 0, path: "A.md", content: "was C" },
        { type: "create", client: 0, path: "B.md", content: "was A" },
        { type: "create", client: 0, path: "C.md", content: "was B" },

        // Reconnect
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
