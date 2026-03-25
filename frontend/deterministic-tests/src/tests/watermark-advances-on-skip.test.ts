import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG FIX: Watermark must advance even when remote updates are skipped.
 *
 * When a remote update is skipped (e.g., because the document already
 * exists locally, or a pending create covers it), the vaultUpdateId
 * must still be recorded via addSeenUpdateId. Otherwise, the watermark
 * stalls and every subsequent reconnect replays stale updates.
 *
 * This test creates a scenario where one client has a pending create
 * at the same path as a remote create. The skipped remote create's
 * vaultUpdateId must be recorded. After a reconnect cycle, the
 * watermark should be past the skipped update.
 */
function verifyConverged(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("doc.md"), "Expected doc.md to exist");
}

export const watermarkAdvancesOnSkipTest: TestDefinition = {
    name: "Watermark Advances When Remote Update Is Skipped",
    description:
        "When a remote update is skipped (already exists, pending create, " +
        "etc.), the vaultUpdateId must still be recorded to prevent " +
        "watermark stalls and unnecessary replays on reconnect.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both go offline and create at the same path
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "create", client: 0, path: "doc.md", content: "from client 0" },
        { type: "create", client: 1, path: "doc.md", content: "from client 1" },

        // Both come online - one will skip the other's remote create
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Disconnect and reconnect to test watermark
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyConverged },
    ],
};
