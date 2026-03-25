import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * EDGE CASE: Two clients create at the same path while offline — mergeable text files.
 *
 * When a remote-update arrives for a path where a local pending create
 * exists, the code at sync-actions.ts line 1161 skips the remote download
 * ONLY for mergeable file types. For mergeable files, the idempotency
 * key resolution will handle the merge correctly.
 *
 * This test verifies that when both clients create at the same path with
 * different text content while offline, the server merges correctly and
 * both clients converge.
 *
 * The interesting edge case is: Client 0 creates and syncs first, then
 * Client 1 creates at the same path. The server's smart create should
 * merge the content (3-way merge with empty parent), and both clients
 * should see both pieces of content.
 */
function verifyMergedContent(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("notes.md"),
        `Expected notes.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const content = state.files.get("notes.md") ?? "";
    assert(
        content.includes("alpha wrote this line"),
        `Expected content to include "alpha wrote this line", got: "${content}"`
    );
    assert(
        content.includes("beta wrote this different line"),
        `Expected content to include "beta wrote this different line", got: "${content}"`
    );
}

export const offlineCreateSamePathMergeableTest: TestDefinition = {
    name: "Offline Create Same Path — Mergeable Text",
    description:
        "Both clients create a file at the same path while offline with " +
        "different text content. When both sync, the server should 3-way " +
        "merge the content and both clients should converge to the merged result.",
    clients: 2,
    steps: [
        // Both clients create at same path while offline
        {
            type: "create",
            client: 0,
            path: "notes.md",
            content: "alpha wrote this line"
        },
        {
            type: "create",
            client: 1,
            path: "notes.md",
            content: "beta wrote this different line"
        },

        // Enable sync — Client 0 syncs first, then Client 1's create
        // triggers a smart merge on the server
        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyMergedContent }
    ]
};
