import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyBothContentAndPath(state: ClientState): void {
    // The file should be at B.md (Client 0 renamed it)
    // AND should contain Client 1's updated content (merged with original)
    const files = Array.from(state.files.keys());
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist, got: ${files.join(", ")}`
    );
    assert(
        !state.files.has("A.md"),
        `A.md should not exist after rename, got: ${files.join(", ")}`
    );
    assert(
        state.files.size === 1,
        `Expected exactly 1 file, got ${state.files.size}: ${files.join(", ")}`
    );

    const content = state.files.get("B.md") ?? "";
    // Client 1 updated the content to include "updated by client 1"
    // The 3-way merge should preserve this update at the renamed path
    assert(
        content.includes("updated by client 1"),
        `Expected B.md to contain "updated by client 1" from the remote update, got: "${content}"`
    );
}

/**
 * BUG: Coalescing table says `move + remote-update = move`, which drops
 * the remote update content. The local client only sends the rename
 * to the server. If the server has no concurrent version to merge with,
 * the remote client's update is lost on this client until a forced
 * re-sync (runFinalConsistencyCheck).
 *
 * This test verifies that when Client 0 renames A.md → B.md while
 * Client 1 simultaneously updates A.md, BOTH the rename and the
 * content update are reflected on both clients.
 */
export const moveAndConcurrentRemoteUpdateTest: TestDefinition = {
    name: "Move and Concurrent Remote Update",
    description:
        "Client 0 renames A.md to B.md while Client 1 updates A.md content. " +
        "The coalescing table merges move + remote-update into just 'move', " +
        "potentially dropping the remote content update. Both clients should " +
        "converge to B.md with Client 1's updated content.",
    clients: 2,
    steps: [
        // Setup: both clients share A.md
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "original content"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "A.md",
            content: "original content"
        },

        // Client 0 goes offline and renames A.md → B.md
        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },

        // Client 1 updates A.md while Client 0 is offline
        {
            type: "update",
            client: 1,
            path: "A.md",
            content: "updated by client 1"
        },
        { type: "sync", client: 1 },

        // Client 0 comes online — will receive remote-update for A.md
        // The move event (A→B) and remote-update should both apply
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyBothContentAndPath }
    ]
};
