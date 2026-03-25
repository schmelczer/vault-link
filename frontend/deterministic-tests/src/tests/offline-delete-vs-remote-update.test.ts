import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyConsistentState(state: ClientState): void {
    // After Client 0 deletes and Client 1 updates the same file,
    // both clients must agree. The delete intent should win (user
    // explicitly deleted the file) and both clients should converge
    // to having no files OR the file re-created.
    //
    // The coalescing path is: local-update enqueued for Client 1's
    // remote broadcast → local-delete arrives → coalesces.
    //
    // Key assertion: both clients must be consistent, regardless
    // of which intent wins.
    const files = Array.from(state.files.keys());
    // File should NOT exist (delete wins in current implementation)
    assert(
        state.files.size === 0,
        `Expected 0 files after delete-wins resolution, got ${state.files.size}: ${files.join(", ")}`
    );
}

/**
 * Tests the coalescing path: `remote-update + local-delete → delete`.
 *
 * When Client 0 comes online after deleting A.md, it receives a
 * remote-update broadcast for A.md from Client 1's edit. The
 * coalescing must produce a `delete` action (not `remote-delete`
 * with isDeleted=false) so the executor properly marks the doc as
 * deleted-locally and sends DELETE to the server.
 *
 * Before the fix: the coalescing produced `remote-delete` with the
 * remote-update version (isDeleted=false). The executor treated this
 * as a tracked doc update, downloaded the remote content, and
 * silently resurrected the file — overriding the user's delete.
 */
export const offlineDeleteVsRemoteUpdateTest: TestDefinition = {
    name: "Offline Delete vs Remote Update",
    description:
        "Client 0 deletes A.md while Client 1 updates A.md. Tests the " +
        "coalescing of remote-update + local-delete and whether both " +
        "clients converge to a consistent state.",
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

        // Client 0 goes offline and deletes A.md
        { type: "disable-sync", client: 0 },
        { type: "delete", client: 0, path: "A.md" },

        // Client 1 updates A.md while Client 0 is offline
        {
            type: "update",
            client: 1,
            path: "A.md",
            content: "important update by client 1"
        },
        { type: "sync", client: 1 },

        // Client 0 comes online — receives remote-update for A.md
        // but has already deleted it locally
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyConsistentState }
    ]
};
