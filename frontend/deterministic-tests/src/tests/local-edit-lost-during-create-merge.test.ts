import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Local edit lost when create returns MergingUpdate.
 *
 * Scenario:
 * 1. Client 1 creates doc.md and syncs it to the server
 * 2. Client 0 (offline) creates doc.md with different content
 * 3. Server is paused, client 0 goes online — create request stalls
 * 4. Client 0 updates the file locally while the create is in-flight
 * 5. Server resumes → create returns MergingUpdate with merged content
 * 6. applyServerResponse reads currentDisk (the local update) and calls
 *    write(path, currentDisk, responseBytes). The 3-way merge sees
 *    parent == ours (currentDisk == currentDisk) → "no local changes" →
 *    overwrites with server content. The local update is permanently lost.
 *
 * Expected: the local edit made during the in-flight create must survive.
 */
function verifyLocalEditPreserved(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("doc.md"), "Expected doc.md to exist");
    const content = state.files.get("doc.md") ?? "";
    assert(
        content.includes("from-client-1"),
        `Expected "from-client-1" in content, got: "${content}"`
    );
    // The critical assertion: the local edit made while the create was
    // in-flight must survive the MergingUpdate 3-way merge.
    assert(
        content.includes("local-edit-during-create"),
        `Expected "local-edit-during-create" in content (lost during merge), got: "${content}"`
    );
}

export const localEditLostDuringCreateMergeTest: TestDefinition = {
    name: "Local Edit Lost During Create-Merge Response",
    description:
        "When a create returns a MergingUpdate and the file was locally " +
        "edited between the request and response, the local edit must " +
        "not be lost by the 3-way merge.",
    clients: 2,
    steps: [
        // Client 1 creates doc.md while client 0 is offline
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "create", client: 1, path: "doc.md", content: "from-client-1" },
        { type: "sync", client: 1 },

        // Client 0 creates the same file offline (doesn't know about client 1's version)
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "from-client-0"
        },

        // Pause server so client 0's create stalls mid-flight
        { type: "pause-server" },

        // Bring client 0 online — its create request will stall
        { type: "enable-sync", client: 0 },

        // Client 0 updates the file WHILE the create is in-flight
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "local-edit-during-create"
        },

        // Resume server — create completes with MergingUpdate
        { type: "resume-server" },

        // Give time for: create response → 3-way merge → follow-up
        // update (detects local edit) → propagation to client 1
        { type: "sync" },
        { type: "sync" },
        { type: "barrier" },

        // The local edit must be preserved
        { type: "assert-consistent", verify: verifyLocalEditPreserved }
    ]
};
