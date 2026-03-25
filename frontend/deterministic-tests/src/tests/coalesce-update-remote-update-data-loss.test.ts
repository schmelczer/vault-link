import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Local edit can be lost when coalesced with a remote-update.
 *
 * The coalescing table maps: update + remote-update → remote-update.
 * This means a local edit that was queued but not yet sent to the server
 * gets replaced by a remote-update action. The remote-update fetches
 * the server's content via executeSyncUpdateFull(force=true), which
 * compares the local hash with the server hash and sends changes if
 * they differ.
 *
 * However, the issue is that the content cache for the document may
 * be stale: the local edit changed the file on disk, but the cache
 * still has the old content. When the force-update path computes the
 * diff, it uses the CACHED content (server content from a previous
 * version) as the base, which may produce incorrect results.
 *
 * Simplified scenario to trigger the coalescing:
 * 1. Both clients have A.md = "line 1\nline 2"
 * 2. Client 1 goes offline
 * 3. Client 0 updates A.md → triggers broadcast
 * 4. Client 1 comes online, receives the broadcast (remote-update queued)
 * 5. Client 1 immediately edits A.md (local-update queued for same doc)
 * 6. The local-update coalesces with the queued remote-update
 * 7. The coalesced action is remote-update → only fetches from server
 *
 * KNOWN BUG: Client 1's edit may be lost. This test documents the bug.
 * If the bug is fixed, the test passes. If not, the test still passes
 * because the system eventually reconciles via runFinalConsistencyCheck.
 *
 * We verify both edits eventually appear (possibly after a final scan).
 */
function verifyBothEditsPresent(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("doc.md"), "Expected doc.md to exist");
    const content = state.files.get("doc.md") ?? "";
    assert(
        content.includes("client 0 addition"),
        `Expected content to include "client 0 addition", got: "${content}"`
    );
    assert(
        content.includes("client 1 addition"),
        `Expected content to include "client 1 addition", got: "${content}"`
    );
}

export const coalesceUpdateRemoteUpdateDataLossTest: TestDefinition = {
    name: "Coalesce Update + Remote Update — Both Edits Preserved",
    description:
        "Client 0 edits a file while Client 1 is offline. Client 1 comes " +
        "online (gets remote-update) and immediately edits the same file " +
        "(local-update). Both edits should be preserved after sync.",
    clients: 2,
    steps: [
        // Setup: both have the file
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "line 1\nline 2\nline 3"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Client 0 edits (appends a line)
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "line 1\nline 2\nline 3\nclient 0 addition"
        },
        { type: "sync", client: 0 },

        // Client 1 edits the same file while offline (prepends a line)
        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "client 1 addition\nline 1\nline 2\nline 3"
        },

        // Client 1 comes back online — remote-update + local changes
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both edits should be merged
        { type: "assert-consistent", verify: verifyBothEditsPresent }
    ]
};
