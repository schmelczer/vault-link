import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyBothContents(state: ClientState): void {
    const files = Array.from(state.files.keys());

    // Both documents were renamed to C.md. One gets C.md, the other should
    // be deconflicted. Both contents must be preserved.
    assert(
        state.files.size === 2,
        `Expected 2 files (both documents preserved), got ${state.files.size}: ${files.join(", ")}`
    );

    // Neither A.md nor B.md should exist (both were renamed away)
    assert(
        !state.files.has("A.md"),
        `A.md should not exist after rename, got: ${files.join(", ")}`
    );
    assert(
        !state.files.has("B.md"),
        `B.md should not exist after rename, got: ${files.join(", ")}`
    );

    // Both contents must be preserved somewhere
    const allContent = Array.from(state.files.values()).join("\n");
    assert(
        allContent.includes("content-a") && allContent.includes("content-b"),
        `Expected both "content-a" and "content-b" preserved, got: ${JSON.stringify(Object.fromEntries(state.files))}`
    );
}

export const concurrentRenameSameTargetTest: TestDefinition = {
    name: "Concurrent Rename to Same Target",
    description:
        "Client 0 renames A.md to C.md while Client 1 (offline) renames B.md to C.md. " +
        "Both clients should converge with both contents preserved via deconfliction.",
    clients: 2,
    steps: [
        // Setup: create A.md and B.md, sync both
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Client 0 renames A.md to C.md and syncs
        { type: "rename", client: 0, oldPath: "A.md", newPath: "C.md" },
        { type: "sync", client: 0 },

        // Client 1 renames B.md to C.md while offline
        { type: "rename", client: 1, oldPath: "B.md", newPath: "C.md" },

        // Client 1 reconnects
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "barrier" },

        // Both contents should be preserved somewhere
        { type: "assert-consistent", verify: verifyBothContents }
    ]
};
