import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyConvergence(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();

    // A.md should exist — the recreate creates a new document
    assert(
        state.files.has("A.md"),
        `Expected A.md to exist. Files: ${files.join(", ")}`
    );

    const content = state.files.get("A.md") ?? "";

    // The recreated content must be present. Client 1's update targeted
    // the old (deleted) document, so it may also appear if the server
    // merged both — but at minimum the recreated content must survive.
    assert(
        content.includes("recreated"),
        `Expected A.md to contain "recreated" from client 0's recreate, got: "${content}"`
    );
}

export const deleteRecreateConcurrentUpdateTest: TestDefinition = {
    name: "Delete + Recreate with Concurrent Remote Update",
    description:
        "Client 0 deletes A.md and recreates it with new content while offline. " +
        "Client 1 (online) updates A.md with different content. When Client 0 " +
        "reconnects, the system must reconcile the delete-recreate with the " +
        "concurrent update. Both clients must converge.",
    clients: 2,
    steps: [
        // Setup
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline, deletes and recreates
        { type: "disable-sync", client: 0 },
        { type: "delete", client: 0, path: "A.md" },
        { type: "create", client: 0, path: "A.md", content: "recreated by client 0" },

        // Client 1 updates the same file concurrently
        {
            type: "update",
            client: 1,
            path: "A.md",
            content: "updated by client 1"
        },
        { type: "sync", client: 1 },

        // Client 0 reconnects
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients must converge
        { type: "assert-consistent", verify: verifyConvergence }
    ]
};
