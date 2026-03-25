import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyLatestVersion(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("evolving.md"),
        `Expected evolving.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const content = state.files.get("evolving.md") ?? "";
    assert(
        content === "version-5-final",
        `Expected evolving.md to have "version-5-final", got: "${content}"`
    );
}

export const offlineMultiUpdateCatchupTest: TestDefinition = {
    name: "Offline Client Catches Up After Multiple Updates",
    description:
        "Client 0 creates a file and both clients sync. Client 1 goes " +
        "offline. Client 0 updates the file 5 times. Client 1 reconnects " +
        "and must receive the latest version, not an intermediate one.",
    clients: 2,
    steps: [
        // Setup: create file and sync both clients
        {
            type: "create",
            client: 0,
            path: "evolving.md",
            content: "version-0-initial"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "evolving.md",
            content: "version-0-initial"
        },

        // Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Client 0 makes several updates while client 1 is offline
        { type: "update", client: 0, path: "evolving.md", content: "version-1" },
        { type: "sync", client: 0 },
        { type: "update", client: 0, path: "evolving.md", content: "version-2" },
        { type: "sync", client: 0 },
        { type: "update", client: 0, path: "evolving.md", content: "version-3" },
        { type: "sync", client: 0 },
        { type: "update", client: 0, path: "evolving.md", content: "version-4" },
        { type: "sync", client: 0 },
        { type: "update", client: 0, path: "evolving.md", content: "version-5-final" },
        { type: "sync", client: 0 },

        // Client 1 reconnects — should catch up to latest
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients must have the final version
        { type: "assert-consistent", verify: verifyLatestVersion }
    ]
};
