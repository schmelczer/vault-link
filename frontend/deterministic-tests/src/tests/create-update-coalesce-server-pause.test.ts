import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyFinalContent(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("doc.md"),
        `Expected doc.md to exist`
    );
    const content = state.files.get("doc.md") ?? "";
    assert(
        content === "final version",
        `Expected doc.md to have "final version", got: "${content}"`
    );
}

export const createUpdateCoalesceServerPauseTest: TestDefinition = {
    name: "Create + Update Coalescing During Server Pause",
    description:
        "Client 0 creates a file and immediately updates it while the server " +
        "is paused. Both operations should coalesce in the queue. When the " +
        "server resumes, the final content should be the updated version.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        // Pause server so HTTP requests stall
        { type: "pause-server" },

        // Client 0: create then immediately update
        { type: "create", client: 0, path: "doc.md", content: "initial" },
        { type: "update", client: 0, path: "doc.md", content: "final version" },

        // Wait a bit for requests to queue up

        // Resume server
        { type: "resume-server" },

        // Both sync
        { type: "sync" },
        { type: "barrier" },

        // Final state: doc.md with "final version" on both clients
        { type: "assert-consistent", verify: verifyFinalContent }
    ]
};
