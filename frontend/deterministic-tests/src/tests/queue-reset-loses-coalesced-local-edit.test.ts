import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const queueResetLosesCoalescedLocalEditTest: TestDefinition = {
    description:
        "Client 0's local update is queued in the wire loop while the " +
        "server is paused (so the POST hangs), then disable-sync forces a " +
        "SyncReset that clears the wire-loop queue. On re-enable, the " +
        "engine MUST rediscover the disk content via offline scan and " +
        "merge it with the meantime remote update — otherwise the " +
        "queue-reset has silently lost a coalesced local edit. (Earlier " +
        "version of this test ran the local update while sync was already " +
        "disabled, so there was no queue to reset.)",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "update", client: 1, path: "doc.md", content: "alpha bravo" },
        { type: "sync", client: 1 },

        // Pause the server so c0's wire loop can enqueue but cannot drain.
        { type: "pause-server" },
        // c0's update is queued in the wire loop; the POST will hang.
        { type: "update", client: 0, path: "doc.md", content: "charlie delta" },
        // disable-sync triggers a SyncReset — the in-flight POST aborts
        // with SyncResetError and the wire-loop queue is cleared.
        { type: "disable-sync", client: 0 },
        { type: "resume-server" },

        // Re-enable. Offline scan must see disk content "charlie delta"
        // and merge it with the server's "alpha bravo".
        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContains(
                    "doc.md",
                    "alpha",
                    "charlie"
                );
            }
        }
    ]
};
