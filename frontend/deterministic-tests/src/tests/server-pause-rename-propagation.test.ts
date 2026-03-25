import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyRename(state: ClientState): void {
    const files = Array.from(state.files.keys());
    assert(
        !state.files.has("original.md"),
        `Expected original.md to NOT exist after rename, got files: ${files.join(", ")}`
    );
    assert(
        state.files.has("renamed.md"),
        `Expected renamed.md to exist after rename, got files: ${files.join(", ")}`
    );
    const content = state.files.get("renamed.md") ?? "";
    assert(
        content === "important data",
        `Expected renamed.md content to be "important data", got: "${content}"`
    );
}

export const serverPauseRenameTest: TestDefinition = {
    name: "Server Pause Then Rename Propagation",
    description:
        "Client 0 creates original.md and both clients sync. The server is paused. " +
        "Client 0 renames original.md to renamed.md while the server is frozen. " +
        "After the server resumes, the rename should propagate to Client 1: " +
        "original.md disappears and renamed.md appears with the same content. " +
        "This tests that rename operations (which are update-with-oldPath on the " +
        "HTTP layer) survive server outages and that Client 1 correctly applies " +
        "the path change from the WebSocket broadcast.",
    clients: 2,
    steps: [
        // Setup: create file and sync both clients
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        {
            type: "create",
            client: 0,
            path: "original.md",
            content: "important data"
        },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "original.md",
            content: "important data"
        },

        // Pause the server, then rename on client 0
        { type: "pause-server" },
        {
            type: "rename",
            client: 0,
            oldPath: "original.md",
            newPath: "renamed.md"
        },

        // Resume the server — the stalled rename request should complete
        { type: "resume-server" },

        { type: "sync" },
        { type: "barrier" },

        // original.md should be gone, renamed.md should exist on both
        { type: "assert-not-exists", client: 0, path: "original.md" },
        { type: "assert-not-exists", client: 1, path: "original.md" },
        { type: "assert-exists", client: 0, path: "renamed.md" },
        { type: "assert-exists", client: 1, path: "renamed.md" },
        { type: "assert-consistent", verify: verifyRename }
    ]
};
