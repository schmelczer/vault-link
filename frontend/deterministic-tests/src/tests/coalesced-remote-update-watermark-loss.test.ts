import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: When remote-update events coalesce, the first vaultUpdateId is lost.
 *
 * In sync-events.ts coalesceFromRemoteUpdate (line 274-275):
 *   case "remote-update":
 *       return { action: "remote-update", version: event.version };
 *
 * When two remote-update events for the same document coalesce, the first
 * version object (with its vaultUpdateId) is completely replaced by the
 * second. The first vaultUpdateId is never recorded in CoveredValues.
 *
 * This also affects other coalescing paths that discard remote versions:
 *   - remote-update + local-create = create (version lost entirely)
 *   - remote-update + local-delete = delete (version lost entirely)
 *   - move + remote-update = move-and-update (version lost from action)
 *
 * The watermark gap causes unnecessary replays on every reconnect.
 *
 * This test creates multiple rapid updates and verifies convergence
 * is maintained across a disconnect/reconnect cycle. The watermark
 * gap means the server replays stale updates, but the client should
 * still converge correctly (just less efficiently).
 */
function verifyContent(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("doc.md"), "Expected doc.md to exist");
    const content = state.files.get("doc.md")!;
    assert(
        content === "final update",
        `Expected "final update", got: "${content}"`
    );
}

export const coalescedRemoteUpdateWatermarkLossTest: TestDefinition = {
    name: "Coalesced Remote Updates Lose Earlier vaultUpdateIds",
    description:
        "When multiple remote-update events for the same document coalesce, " +
        "only the last vaultUpdateId is recorded. Earlier IDs create " +
        "permanent watermark gaps that cause unnecessary server replays " +
        "on every reconnect.",
    clients: 2,
    steps: [
        // Setup: both clients have doc.md
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 sends three rapid updates
        { type: "update", client: 0, path: "doc.md", content: "update 1" },
        { type: "update", client: 0, path: "doc.md", content: "update 2" },
        { type: "update", client: 0, path: "doc.md", content: "final update" },
        { type: "sync", client: 0 },

        // Client 1 processes — some remote-updates may coalesce
        { type: "sync", client: 1 },
        { type: "barrier" },
        { type: "assert-consistent", verify: verifyContent },

        // Disconnect and reconnect both clients
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // After reconnect, convergence should be maintained
        // (even if the watermark caused unnecessary replays)
        { type: "assert-consistent", verify: verifyContent },

        // Second reconnect cycle — should still be stable
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-consistent", verify: verifyContent }
    ]
};
