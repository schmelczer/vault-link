import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyBothFiles(state: ClientState): void {
    assert(
        state.files.has("alpha.md"),
        `Expected alpha.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("beta.md"),
        `Expected beta.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const alphaContent = state.files.get("alpha.md") ?? "";
    const betaContent = state.files.get("beta.md") ?? "";
    assert(
        alphaContent.includes("from client 0"),
        `Expected alpha.md to contain "from client 0", got: "${alphaContent}"`
    );
    assert(
        betaContent.includes("from client 1"),
        `Expected beta.md to contain "from client 1", got: "${betaContent}"`
    );
}

export const serverPauseBothClientsCreateTest: TestDefinition = {
    name: "Server Pause While Both Clients Create",
    description:
        "Both clients are synced. Client 0 creates alpha.md. The server is immediately " +
        "paused (SIGSTOP), stalling in-flight requests and WebSocket broadcasts. " +
        "While the server is paused, Client 1 creates beta.md (its request will also stall). " +
        "After the server resumes, both files should propagate to both clients. " +
        "This tests that the retry logic on both clients correctly recovers stalled " +
        "HTTP creates and that WebSocket reconnection delivers the missed broadcasts.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 creates a file, then immediately pause the server
        // so the create response (or broadcast to client 1) may be stalled
        {
            type: "create",
            client: 0,
            path: "alpha.md",
            content: "from client 0"
        },
        { type: "pause-server" },

        // While server is paused, client 1 creates a different file.
        // This HTTP request will stall until the server is resumed.
        {
            type: "create",
            client: 1,
            path: "beta.md",
            content: "from client 1"
        },

        // Resume the server — both stalled requests should complete
        { type: "resume-server" },

        // Let both clients finish all pending sync work
        { type: "sync" },
        { type: "barrier" },

        // Both files must exist on both clients
        { type: "assert-exists", client: 0, path: "alpha.md" },
        { type: "assert-exists", client: 0, path: "beta.md" },
        { type: "assert-exists", client: 1, path: "alpha.md" },
        { type: "assert-exists", client: 1, path: "beta.md" },
        { type: "assert-consistent", verify: verifyBothFiles }
    ]
};
