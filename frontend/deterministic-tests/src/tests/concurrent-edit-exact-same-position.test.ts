import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyMergedEdits(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}`
    );
    assert(
        state.files.has("doc.md"),
        `Expected doc.md to exist`
    );
    const content = state.files.get("doc.md") ?? "";

    // Both clients replaced the same word. The 3-way merge with
    // parent "the quick brown fox" should detect that both sides
    // changed "quick" — one to "slow" and one to "fast".
    // reconcile-text does word-level tokenization, so both
    // replacements should appear (though order may vary).
    assert(
        content.includes("slow") && content.includes("fast"),
        `Expected merged content to contain both "slow" and "fast", got: "${content}"`
    );
    assert(
        content.includes("brown fox"),
        `Expected merged content to preserve unchanged text "brown fox", got: "${content}"`
    );
}

/**
 * Tests 3-way merge when both clients edit the exact same word in a
 * document. Client 0 replaces "quick" with "slow", Client 1 replaces
 * "quick" with "fast". The merge should detect the conflicting edits
 * and preserve both (the merge algorithm does not silently drop one).
 *
 * This is a stress test for the reconcile-text library's word-level
 * tokenizer when operating on overlapping changes at the same offset.
 */
export const concurrentEditExactSamePositionTest: TestDefinition = {
    name: "Concurrent Edit at Exact Same Position",
    description:
        "Both clients edit the exact same word in a file. Client 0 changes " +
        "'quick' to 'slow', Client 1 changes 'quick' to 'fast'. The 3-way " +
        "merge should detect the overlapping edit and produce a result that " +
        "preserves both changes.",
    clients: 2,
    steps: [
        // Setup: shared document
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "the quick brown fox"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "doc.md",
            content: "the quick brown fox"
        },

        // Both clients go offline and edit the same word
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "the slow brown fox"
        },
        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "the fast brown fox"
        },

        // Both come online
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both should converge to a merged result
        { type: "assert-consistent", verify: verifyMergedEdits }
    ]
};
