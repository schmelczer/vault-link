import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const coalescedRemoteUpdateWatermarkLossTest: TestDefinition = {
    description:
        "Probes that the watermark advances correctly through coalesced " +
        "remote updates. Client 0 sends three rapid updates, all observed " +
        "by Client 1 (their vault_update_ids may coalesce in the engine's " +
        "MinCovered). Then Client 1 disconnects and Client 0 issues one " +
        "MORE update while Client 1 is offline. On Client 1's reconnect, " +
        "catch-up uses last_seen_vault_update_id — if the coalesced " +
        "updates wrongly advanced the watermark past Client 0's offline " +
        "update's id, that update is silently lost. The final assert " +
        "pins Client 1 receiving the post-reconnect update via catch-up.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        // Three rapid updates — coalesce in engine queues; both clients
        // converge to "final update".
        { type: "update", client: 0, path: "doc.md", content: "update 1" },
        { type: "update", client: 0, path: "doc.md", content: "update 2" },
        { type: "update", client: 0, path: "doc.md", content: "final update" },
        { type: "barrier" },

        // Client 1 goes offline.
        { type: "disable-sync", client: 1 },

        // Client 0 issues a follow-up edit while c1 is offline. This
        // event has a vault_update_id strictly greater than the
        // coalesced sequence; if c1's watermark is correct, catch-up
        // will return it. If the watermark wrongly advanced past it
        // during the coalesce (too-new), catch-up returns nothing and
        // c1 silently misses this edit.
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "post-reconnect edit"
        },
        { type: "sync", client: 0 },

        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent(
                    "doc.md",
                    "post-reconnect edit"
                );
            }
        }
    ]
};
