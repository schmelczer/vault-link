import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * EDGE CASE: File moved AND edited to have the same hash as another file.
 *
 * reconcileWithDisk detects moves by matching content hashes. But if a
 * file is moved AND edited such that its new content matches a different
 * missing file's hash, the move detection assigns it to the WRONG document.
 *
 * Scenario:
 * 1. Two files exist: A.md ("content A") and B.md ("content B")
 * 2. Client goes offline
 * 3. A.md is deleted, B.md is renamed to C.md and edited to "content A"
 * 4. On reconnect, reconcileWithDisk sees:
 *    - Missing: A.md (hash="content A"), B.md (hash="content B")
 *    - New: C.md (hash="content A")
 *    - C.md's hash matches A.md's hash → wrong move detection!
 *    - B.md is treated as deleted instead of renamed
 *
 * The system should still converge correctly despite the false match.
 */
function verifyFinalState(state: ClientState): void {
    assert(!state.files.has("A.md"), "A.md should not exist");
    assert(!state.files.has("B.md"), "B.md should not exist");
    assert(state.files.has("C.md"), "C.md should exist");
    const content = state.files.get("C.md") ?? "";
    assert(
        content === "content A",
        `Expected C.md to contain "content A", got: "${content}"`
    );
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
}

export const offlineEditThenMoveSameContentTest: TestDefinition = {
    name: "Offline Move + Edit Creates False Hash Match",
    description:
        "A file is renamed and edited to have the same content as a deleted " +
        "file. Move detection may match against the wrong document. The " +
        "system should still converge.",
    clients: 2,
    steps: [
        // Setup: create two files with different content
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "content A"
        },
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "content B"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline
        { type: "disable-sync", client: 0 },

        // Delete A.md
        { type: "delete", client: 0, path: "A.md" },

        // Rename B.md → C.md
        { type: "rename", client: 0, oldPath: "B.md", newPath: "C.md" },

        // Edit C.md to have the same content as the now-deleted A.md
        {
            type: "update",
            client: 0,
            path: "C.md",
            content: "content A"
        },

        // Reconnect
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
