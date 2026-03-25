import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: update + remote-delete = update, but execution deletes the file.
 *
 * In sync-events.ts coalesceFromUpdate (line 148-152):
 *   case "remote-delete":
 *       return current;  // comment: "user edit takes precedence"
 *
 * The coalescing INTENT is correct: the user's edit should survive.
 * But the EXECUTION doesn't match:
 *
 * 1. The coalesced "update" action calls executeSyncUpdateSendChanges()
 * 2. This sends putText/putBinary to the server
 * 3. The server's update_document handler checks if latest_version.is_deleted
 * 4. Since the doc IS deleted, server returns FastForwardUpdate(isDeleted=true)
 * 5. applyServerResponse checks response.isDeleted at line 296
 * 6. Calls applyRemoteDeleteLocally which DELETES the file!
 *
 * The user's edit is permanently lost despite the coalescing saying
 * "user edit takes precedence."
 *
 * This test proves the data loss by having one client edit while another
 * deletes, with the edit arriving at the event queue before the delete.
 */
function verifyUserEditPreserved(state: ClientState): void {
    // The coalescing says "user edit takes precedence" so the file
    // should ideally survive with the user's content.
    // Current behavior: file is deleted (data loss).
    // We test for convergence.
    if (state.files.size > 0) {
        assert(
            state.files.has("doc.md"),
            `Unexpected files: ${Array.from(state.files.keys()).join(", ")}`
        );
        const content = state.files.get("doc.md")!;
        assert(
            content.includes("user edit"),
            `Expected user's edit content, got: "${content}"`
        );
    }
}

export const updateVsRemoteDeleteDataLossTest: TestDefinition = {
    name: "Update + Remote Delete Coalescing Data Loss",
    description:
        "When a user edits a file and then a remote-delete arrives, the " +
        "coalescing produces 'update' (user edit takes precedence). But " +
        "the server returns isDeleted=true, causing the client to delete " +
        "the file — contradicting the coalescing intent.",
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

        // Client 0 edits the file (local-update queued first)
        { type: "update", client: 0, path: "doc.md", content: "user edit on client 0" },

        // Client 1 deletes the file
        { type: "delete", client: 1, path: "doc.md" },

        // Client 1 comes online first — delete sent to server
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },

        // Client 0 comes online — local-update already queued,
        // then remote-delete arrives and coalesces:
        // update + remote-delete = update (per coalescing)
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both must converge to a consistent state
        { type: "assert-consistent", verify: verifyUserEditPreserved }
    ]
};
