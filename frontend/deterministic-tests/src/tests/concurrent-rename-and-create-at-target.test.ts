import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * EDGE CASE: Client A renames X→Y while Client B creates at Y.
 *
 * This tests a tricky scenario where:
 * 1. Both clients know about X.md
 * 2. Client A renames X→Y (offline)
 * 3. Client B creates a NEW file at Y (offline)
 * 4. Both reconnect
 *
 * The server should handle this by:
 * - Client A's rename succeeds (X→Y)
 * - Client B's create at Y triggers a smart merge with A's renamed document
 * - Both documents' content should be preserved
 */
function verifyFinalState(state: ClientState): void {
    // X should not exist (renamed by A)
    assert(
        !state.files.has("X.md"),
        `X.md should not exist, files: ${Array.from(state.files.keys()).join(", ")}`
    );

    // Y should exist with merged content
    assert(
        state.files.has("Y.md"),
        `Y.md should exist, files: ${Array.from(state.files.keys()).join(", ")}`
    );

    const content = state.files.get("Y.md") ?? "";
    // Both pieces of content should be preserved through merge
    assert(
        content.includes("original file X"),
        `Expected content to include "original file X", got: "${content}"`
    );
    assert(
        content.includes("brand new Y content"),
        `Expected content to include "brand new Y content", got: "${content}"`
    );
}

export const concurrentRenameAndCreateAtTargetTest: TestDefinition = {
    name: "Concurrent Rename to Path + Create at Same Path",
    description:
        "Client 0 renames X→Y while Client 1 creates a new file at Y. " +
        "Both operations happen offline. On reconnect, the server should " +
        "merge the renamed document with the created document.",
    clients: 2,
    steps: [
        // Setup: create X.md on Client 0
        {
            type: "create",
            client: 0,
            path: "X.md",
            content: "original file X"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Client 0: rename X→Y
        { type: "rename", client: 0, oldPath: "X.md", newPath: "Y.md" },

        // Client 1: create Y with different content
        // (Client 1 still has X.md locally)
        {
            type: "create",
            client: 1,
            path: "Y.md",
            content: "brand new Y content"
        },

        // Client 0 reconnects first (rename goes through)
        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },

        // Client 1 reconnects (create at Y triggers smart merge)
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
