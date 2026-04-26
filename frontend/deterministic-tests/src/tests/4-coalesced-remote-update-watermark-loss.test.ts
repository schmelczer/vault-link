import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const coalescedRemoteUpdateWatermarkLossTest: TestDefinition = {
    description:
        "Client 0 sends three rapid updates. After syncing, both clients " +
        "disconnect and reconnect twice. Content should remain correct " +
        "after each reconnect.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "update", client: 0, path: "doc.md", content: "update 1" },
        { type: "update", client: 0, path: "doc.md", content: "update 2" },
        { type: "update", client: 0, path: "doc.md", content: "final update" },

        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("doc.md", "final update");
            }
        },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("doc.md", "final update");
            }
        },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("doc.md", "final update");
            }
        }
    ]
};
