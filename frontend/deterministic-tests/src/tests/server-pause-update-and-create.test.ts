import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyFinalState(state: ClientState): void {
    // The updated file must exist with the new content
    assert(
        state.files.has("shared.md"),
        `Expected shared.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const sharedContent = state.files.get("shared.md") ?? "";
    assert(
        sharedContent === "updated during pause",
        `Expected shared.md to be "updated during pause", got: "${sharedContent}"`
    );

    // The new file created by client 1 during the pause must also exist
    assert(
        state.files.has("new-file.md"),
        `Expected new-file.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const newContent = state.files.get("new-file.md") ?? "";
    assert(
        newContent === "created by client 1",
        `Expected new-file.md to be "created by client 1", got: "${newContent}"`
    );
}

export const serverPauseUpdateAndCreateTest: TestDefinition = {
    name: "Server Pause — Update and Create Simultaneously",
    description:
        "Client 0 creates shared.md and both clients sync. The server is paused. " +
        "Client 0 updates shared.md to new content. Client 1 creates an entirely " +
        "new file new-file.md. Both HTTP requests stall. After the server resumes, " +
        "the update and the create should both complete. Client 1 should see the " +
        "updated content in shared.md, and Client 0 should see new-file.md. " +
        "This tests that mixed operation types (update + create) from different " +
        "clients both survive a server outage and that the WebSocket reconnection " +
        "delivers all missed broadcasts.",
    clients: 2,
    steps: [
        // Setup: create shared.md and sync
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        {
            type: "create",
            client: 0,
            path: "shared.md",
            content: "initial content"
        },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "shared.md",
            content: "initial content"
        },

        // Pause the server
        { type: "pause-server" },

        // Client 0 updates the existing file (stalls)
        {
            type: "update",
            client: 0,
            path: "shared.md",
            content: "updated during pause"
        },
        // Client 1 creates a brand-new file (stalls)
        {
            type: "create",
            client: 1,
            path: "new-file.md",
            content: "created by client 1"
        },

        // Resume server — both operations should complete
        { type: "resume-server" },

        { type: "sync" },
        { type: "barrier" },

        // Verify final state
        { type: "assert-exists", client: 0, path: "shared.md" },
        { type: "assert-exists", client: 0, path: "new-file.md" },
        { type: "assert-exists", client: 1, path: "shared.md" },
        { type: "assert-exists", client: 1, path: "new-file.md" },
        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
