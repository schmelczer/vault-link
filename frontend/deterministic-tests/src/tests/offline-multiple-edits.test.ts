import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyOnlyLatestVersion(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("doc.md"),
        `Expected doc.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const content = state.files.get("doc.md") ?? "";
    assert(
        content === "edit-5-final",
        `Expected doc.md to have "edit-5-final" (latest edit), got: "${content}"`
    );
}

export const offlineMultipleEditsTest: TestDefinition = {
    name: "Offline Multiple Edits Converge to Latest",
    description:
        "Client 0 creates a file and syncs. Client 0 goes offline, edits the file " +
        "5 times with different content. When Client 0 reconnects, both clients " +
        "must converge to the final version.",
    clients: 2,
    steps: [
        // Setup: create file and sync to both clients
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "doc.md",
            content: "original"
        },

        // Client 0 goes offline
        { type: "disable-sync", client: 0 },

        // Client 0 makes 5 sequential edits while offline
        { type: "update", client: 0, path: "doc.md", content: "edit-1" },
        { type: "update", client: 0, path: "doc.md", content: "edit-2" },
        { type: "update", client: 0, path: "doc.md", content: "edit-3" },
        { type: "update", client: 0, path: "doc.md", content: "edit-4" },
        { type: "update", client: 0, path: "doc.md", content: "edit-5-final" },

        // Client 0 reconnects -- offline reconciliation should detect the
        // changed hash and sync the current on-disk content (edit-5-final)
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should have the final version
        {
            type: "assert-content",
            client: 0,
            path: "doc.md",
            content: "edit-5-final"
        },
        {
            type: "assert-content",
            client: 1,
            path: "doc.md",
            content: "edit-5-final"
        },
        { type: "assert-consistent", verify: verifyOnlyLatestVersion }
    ]
};
