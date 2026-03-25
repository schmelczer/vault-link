import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * EDGE CASE: Both clients edit the same file while server is paused.
 *
 * When the server is paused (SIGSTOP), both clients' HTTP requests stall.
 * When the server resumes, both updates arrive nearly simultaneously.
 * The server processes them sequentially (SQLite), so one will be a
 * FastForwardUpdate and the other will trigger a 3-way merge.
 *
 * This test verifies:
 * 1. Both edits are preserved in the merged result
 * 2. Both clients converge to the same content
 * 3. The content cache on both clients is correct after the merge
 *    (subsequent edits use the right diff base)
 *
 * After the initial merge converges, Client 0 makes another edit to
 * verify the content cache is correct — if the cache has wrong content,
 * the diff will be computed incorrectly and the update will fail.
 */
function verifyBothConcurrentEdits(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("shared.md"), "Expected shared.md to exist");
    const content = state.files.get("shared.md") ?? "";
    assert(
        content.includes("edited by client 0"),
        `Expected content to include client 0's edit, got: "${content}"`
    );
    assert(
        content.includes("edited by client 1"),
        `Expected content to include client 1's edit, got: "${content}"`
    );
}

function verifyPostMergeEdit(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("shared.md"), "Expected shared.md to exist");
    const content = state.files.get("shared.md") ?? "";
    assert(
        content.includes("post-merge edit from client 0"),
        `Expected content to include post-merge edit, got: "${content}"`
    );
}

export const serverPauseBothEditSameFileTest: TestDefinition = {
    name: "Server Pause — Both Clients Edit Same File + Post-Merge Edit",
    description:
        "Both clients edit the same file while the server is paused. " +
        "After resume and convergence, Client 0 makes another edit to " +
        "verify the content cache is consistent (correct diff base).",
    clients: 2,
    steps: [
        // Setup
        {
            type: "create",
            client: 0,
            path: "shared.md",
            content: "line 1: original\nline 2: original\nline 3: original"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Pause server
        { type: "pause-server" },

        // Both clients edit different sections
        {
            type: "update",
            client: 0,
            path: "shared.md",
            content:
                "line 1: edited by client 0\nline 2: original\nline 3: original"
        },
        {
            type: "update",
            client: 1,
            path: "shared.md",
            content:
                "line 1: original\nline 2: original\nline 3: edited by client 1"
        },

        // Resume — both updates hit server nearly simultaneously
        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        // Verify both concurrent edits are preserved in the merge
        { type: "assert-consistent", verify: verifyBothConcurrentEdits },

        // Now Client 0 makes another edit (verifies content cache is correct)
        {
            type: "update",
            client: 0,
            path: "shared.md",
            content: "post-merge edit from client 0"
        },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyPostMergeEdit }
    ]
};
