import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Smart create merge with empty parent can lose content.
 *
 * When the server merges a create with an existing document, it uses a
 * 3-way merge with empty parent: reconcile("", existingContent, newContent).
 *
 * This is correct when both sides are independent additions. But when the
 * existing content was an UPDATE (replacing previous content), the merge
 * treats the update as an addition and produces garbled output.
 *
 * Specifically: if existingContent = "updated by client 1" (which replaced
 * "original"), the merge sees it as an addition of "updated by client 1"
 * from nothing. The new content "created by client 0" is also an addition
 * from nothing. The merge concatenates both — but the word fragments from
 * "created" can bleed into "updated", producing garbage like
 * "createdupdated by client 0 offline".
 *
 * This test verifies that the system produces a VALID merge where at least
 * both clients' content fragments appear, even if the merge isn't perfect.
 *
 * Root cause: The empty parent in merge_with_stored_version (CLAUDE.md
 * invariant #15) is necessary to prevent last-write-wins, but it can
 * produce suboptimal merges when one side is a replacement of previous
 * content (not a pure addition).
 */
function verifyMergedContent(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("notes.md"), "Expected notes.md to exist");
    const content = state.files.get("notes.md") ?? "";
    // Both pieces of content should appear in the merge
    assert(
        content.includes("client 1 update") && content.includes("client 0 offline"),
        `Expected merged content to contain fragments from both clients, got: "${content}"`
    );
}

export const reconcilePendingAtOccupiedPathTest: TestDefinition = {
    name: "Offline Create at Path Updated by Other Client",
    description:
        "Client 1 creates and updates a file. Client 0 goes offline and " +
        "creates a file at the same path. On reconnect, the server merges " +
        "with empty parent. Both clients should converge.",
    clients: 2,
    steps: [
        // Client 1 creates and updates
        {
            type: "create",
            client: 1,
            path: "notes.md",
            content: "client 1 original"
        },
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },

        // Enable Client 0, sync, then go offline
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Client 1 updates the file
        {
            type: "update",
            client: 1,
            path: "notes.md",
            content: "client 1 update replaces everything"
        },
        { type: "sync", client: 1 },

        // Client 0 goes offline and creates at same path
        { type: "disable-sync", client: 0 },

        // Delete the synced copy and create new content
        { type: "delete", client: 0, path: "notes.md" },
        {
            type: "create",
            client: 0,
            path: "notes.md",
            content: "client 0 offline creates new content"
        },

        // Reconnect
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Should converge (possibly with suboptimal merge)
        { type: "assert-consistent", verify: verifyMergedContent }
    ]
};
