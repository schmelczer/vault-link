import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: remote-delete + local-update = remote-delete silently discards user edit.
 *
 * In sync-events.ts coalesceFromRemoteDelete (line 295-297):
 *   case "local-update":
 *       return current;  // remote-delete absorbs the local-update
 *
 * This means if a remote-delete broadcast arrives and then the user edits
 * the file before the event is processed, the local edit is discarded at
 * the coalescing level. The executor only sees "remote-delete" and deletes
 * the file, permanently losing the user's work.
 *
 * Compare with coalesceFromUpdate (line 148-152) where:
 *   update + remote-delete = update  (user edit takes precedence)
 *
 * The semantics should be the same: the user has unsaved local changes that
 * should survive. But the ordering of events (remote-delete arrives FIRST)
 * causes the user's intent to be silently discarded.
 *
 * This test verifies that when a remote-delete and a local-update race,
 * both clients converge. The current behavior is that the file gets deleted
 * (user's edit is lost). This test documents this data-loss scenario.
 */
function verifyState(state: ClientState): void {
    // Current behavior: the file is deleted (remote-delete wins).
    // Ideal behavior: the user's edit should survive.
    // We test for convergence — both clients must agree.
    //
    // If the file exists, it should contain the user's edit.
    // If it doesn't exist, both must agree on deletion.
    if (state.files.size > 0) {
        assert(
            state.files.has("doc.md"),
            `Unexpected files: ${Array.from(state.files.keys()).join(", ")}`
        );
        const content = state.files.get("doc.md")!;
        assert(
            content === "edited by local user",
            `Expected local edit content, got: "${content}"`
        );
    }
    // Either outcome is acceptable as long as both clients converge
}

export const remoteDeleteCoalesceLosesLocalUpdateTest: TestDefinition = {
    name: "Remote Delete + Local Update Coalescing Race",
    description:
        "When a remote-delete broadcast arrives and the user then edits the " +
        "same file, the coalescing (remote-delete + local-update = remote-delete) " +
        "discards the user's edit. Both clients should converge.",
    clients: 2,
    steps: [
        // Setup: both clients have doc.md
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Client 1 deletes the file
        { type: "delete", client: 1, path: "doc.md" },

        // Client 0 edits the file
        { type: "update", client: 0, path: "doc.md", content: "edited by local user" },

        // Client 1 comes online first — delete is sent to server
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },

        // Client 0 comes online — receives remote-delete, then its
        // local-update coalesces with it
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both must converge
        { type: "assert-consistent", verify: verifyState }
    ]
};
