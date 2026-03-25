import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * COMPLEX EDGE CASE: Three clients perform conflicting operations simultaneously.
 *
 * Client A renames X→Y, Client B deletes X, Client C creates Y.
 * This exercises multiple conflict resolution paths at once:
 *
 * - Client A's rename needs the old path X (which Client B is deleting)
 * - Client C's create at Y conflicts with Client A's rename destination
 * - The server must handle all three operations arriving in arbitrary order
 *
 * Expected behavior:
 * - The rename from A should succeed (it was initiated before B's delete)
 * - B's delete of X is effectively a no-op since A already moved it away
 * - C's create at Y triggers a smart merge with A's renamed document
 * - Final state: Y exists with merged content from A and C
 */
function verifyFinalState(state: ClientState): void {
    // X should not exist (renamed/deleted)
    assert(
        !state.files.has("X.md"),
        `X.md should not exist, files: ${Array.from(state.files.keys()).join(", ")}`
    );

    // Y should exist with content from both A's original and C's create
    assert(
        state.files.has("Y.md"),
        `Y.md should exist, files: ${Array.from(state.files.keys()).join(", ")}`
    );
    const content = state.files.get("Y.md") ?? "";
    // Both contents should be merged (A's rename + C's create at same path)
    assert(
        content.includes("original from A") &&
            content.includes("new from C"),
        `Y.md should contain merged content from both A and C, got: "${content}"`
    );
}

export const threeClientRenameCreateDeleteTest: TestDefinition = {
    name: "Three Clients: Rename + Delete + Create Conflict",
    description:
        "Client 0 renames X→Y, Client 1 deletes X, Client 2 creates Y. " +
        "All three operations happen while the other clients are offline. " +
        "Tests that the system handles the three-way conflict and converges.",
    clients: 3,
    steps: [
        // Setup: Client 0 creates X.md, all sync
        {
            type: "create",
            client: 0,
            path: "X.md",
            content: "original from A"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "enable-sync", client: 2 },
        { type: "sync" },
        { type: "barrier" },

        // All clients go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "disable-sync", client: 2 },

        // Client 0: rename X→Y
        { type: "rename", client: 0, oldPath: "X.md", newPath: "Y.md" },

        // Client 1: delete X
        { type: "delete", client: 1, path: "X.md" },

        // Client 2: create Y with different content
        {
            type: "create",
            client: 2,
            path: "Y.md",
            content: "new from C"
        },

        // Bring all clients back online, one at a time
        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },

        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 2 },
        { type: "sync" },
        { type: "barrier" },

        // All clients should converge
        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
