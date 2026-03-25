import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Queue reset discards local events embedded in remote action types.
 *
 * In sync-event-queue.ts reset() (line 172-179):
 *   for (const [key, state] of this.documentStates.entries()) {
 *       if (state.action === "remote-update" || state.action === "remote-delete") {
 *           this.documentStates.delete(key);
 *       }
 *   }
 *
 * This removes all actions with type "remote-update" or "remote-delete".
 * But coalescing can embed local events INTO remote actions:
 *
 *   remote-update + local-update = remote-update (line 262-264)
 *   remote-delete + local-update = remote-delete (line 295-297)
 *   remote-delete + local-move  = remote-delete (line 301-303)
 *
 * When the queue resets (WebSocket disconnect), these coalesced actions
 * are removed — silently discarding the local-update/move intent.
 *
 * The local edit IS recovered on the next reconnect via
 * scheduleSyncForOfflineChanges() (which scans the filesystem and
 * detects hash mismatches). But there is a narrow window where the
 * edit could be lost if metadata was partially updated.
 *
 * This test verifies that local edits survive a disconnect that happens
 * while the edit is coalesced with a remote event.
 */
function verifyEditSurvived(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("doc.md"), "Expected doc.md to exist");
    const content = state.files.get("doc.md")!;
    // Both edits should survive — the filesystem scan on reconnect must recover the local edit
    assert(
        content.includes("from client 0") && content.includes("from client 1"),
        `Expected merged content with both edits, got: "${content}"`
    );
}

export const queueResetLosesCoalescedLocalEditTest: TestDefinition = {
    name: "Queue Reset Preserves Coalesced Local Edits",
    description:
        "When a local-update is coalesced into a remote-update action " +
        "and then the WebSocket disconnects, the queue reset removes " +
        "the remote-update — potentially losing the local edit. " +
        "The filesystem scan on reconnect should recover it.",
    clients: 2,
    steps: [
        // Setup: both clients have doc.md
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 1 edits — this will broadcast a remote-update to client 0
        { type: "update", client: 1, path: "doc.md", content: "from client 1" },
        { type: "sync", client: 1 },

        // Client 0 edits (local-update) — may coalesce with the pending
        // remote-update in the queue as: remote-update + local-update = remote-update
        { type: "update", client: 0, path: "doc.md", content: "from client 0" },

        // Immediately disconnect client 0 — queue.reset() removes remote events
        { type: "disable-sync", client: 0 },

        // Reconnect — scheduleSyncForOfflineChanges should detect the
        // local edit via hash mismatch and re-queue it
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both must converge with the local edit preserved
        { type: "assert-consistent", verify: verifyEditSurvived }
    ]
};
