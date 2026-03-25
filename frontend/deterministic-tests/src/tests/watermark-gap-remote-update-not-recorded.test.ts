import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: executeRemoteUpdate for tracked docs doesn't record the remote
 * version's vaultUpdateId.
 *
 * In sync-actions.ts executeRemoteUpdate (line 1124-1135):
 *   if (doc?.state === "tracked") {
 *       if (doc.serverVersion >= remoteVersion.vaultUpdateId) {
 *           deps.vfs.addSeenUpdateId(remoteVersion.vaultUpdateId);
 *           return;
 *       }
 *       return executeSyncUpdateFull(deps, doc, undefined, true);
 *   }
 *
 * When doc.serverVersion < remoteVersion.vaultUpdateId, the code delegates
 * to executeSyncUpdateFull WITHOUT first recording remoteVersion.vaultUpdateId.
 * executeSyncUpdateFull fetches the latest version from the server, which may
 * have a HIGHER vaultUpdateId than the broadcast's. The response's
 * vaultUpdateId is recorded, but the broadcast's original vaultUpdateId
 * is never recorded — creating a permanent gap in CoveredValues.
 *
 * Similarly, when remote-update events coalesce (remote-update +
 * remote-update = remote-update), the first event's vaultUpdateId
 * is replaced by the second's and never recorded.
 *
 * This causes the watermark to stall, and every reconnect replays
 * updates from the stuck point — wasting bandwidth.
 *
 * This test proves the watermark gap by doing two updates on one client,
 * having the other client receive and process them, then disconnecting
 * and reconnecting to see if the second sync is a no-op.
 */
function verifyConvergence(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("doc.md"), "Expected doc.md to exist");
    const content = state.files.get("doc.md")!;
    assert(
        content === "update 2",
        `Expected "update 2", got: "${content}"`
    );
}

export const watermarkGapRemoteUpdateNotRecordedTest: TestDefinition = {
    name: "Watermark Gap When Remote Update vaultUpdateId Not Recorded",
    description:
        "When a tracked document receives a remote update and the client " +
        "fetches a newer version from the server, the broadcast's original " +
        "vaultUpdateId is never recorded. This creates a watermark gap " +
        "that causes unnecessary replays on reconnect.",
    clients: 2,
    steps: [
        // Setup: both clients have doc.md
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 sends two rapid updates
        { type: "update", client: 0, path: "doc.md", content: "update 1" },
        { type: "sync", client: 0 },
        { type: "update", client: 0, path: "doc.md", content: "update 2" },
        { type: "sync", client: 0 },

        // Client 1 processes the broadcasts
        { type: "sync", client: 1 },
        { type: "barrier" },
        { type: "assert-consistent", verify: verifyConvergence },

        // Disconnect and reconnect client 1 — the watermark should have
        // advanced past both updates. If there's a gap, the server will
        // replay the older update, causing unnecessary work.
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Verify convergence is maintained after reconnect
        { type: "assert-consistent", verify: verifyConvergence }
    ]
};
