import type { TestDefinition } from "../test-definition";
import type { AssertableState } from "../utils/assertable-state";

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
        { type: "barrier" },

        // Client 0 sends three rapid updates
        { type: "update", client: 0, path: "doc.md", content: "update 1" },
        { type: "update", client: 0, path: "doc.md", content: "update 2" },
        { type: "update", client: 0, path: "doc.md", content: "final update" },
        { type: "sync", client: 0 },

        { type: "barrier" },
        { type: "assert-consistent", verify: verifyContent },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyContent },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        { type: "assert-consistent", verify: verifyContent }
    ]
};


function verifyContent(state: AssertableState): void {
    state.assertFileCount(1).assertContent("doc.md", "final update");
}
