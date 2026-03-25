import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyFinalState(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}`
    );
    assert(
        state.files.has("doc.md"),
        `Expected doc.md to exist`
    );
    const content = state.files.get("doc.md") ?? "";

    // After the merge and three rapid updates, "update 3" should be present.
    // Earlier updates may be coalesced, but the final state must include the
    // last update's content.
    assert(
        content.includes("update 3"),
        `Expected final content to include "update 3", got: "${content}"`
    );
}

export const rapidUpdatesAfterMergeTest: TestDefinition = {
    name: "Rapid Sequential Updates After Concurrent Merge",
    description:
        "Both clients create the same file (triggering a merge). After merge " +
        "completes, Client 0 rapidly sends three updates in succession. Each " +
        "update must correctly use the content cache to compute diffs against " +
        "the right parent version. Tests that the cache stores server content " +
        "(not local content) after MergingUpdate.",
    clients: 2,
    steps: [
        // Both create at same path (triggers merge)
        { type: "create", client: 0, path: "doc.md", content: "from client 0" },
        { type: "create", client: 1, path: "doc.md", content: "from client 1" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // After merge, Client 0 sends rapid sequential updates
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "update 1"
        },
        { type: "sync", client: 0 },

        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "update 2"
        },
        { type: "sync", client: 0 },

        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "update 3"
        },
        { type: "sync", client: 0 },

        // Wait for propagation
        { type: "barrier" },

        // Both clients must converge with update 3
        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
