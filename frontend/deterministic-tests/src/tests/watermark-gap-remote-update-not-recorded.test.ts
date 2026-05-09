import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const watermarkGapRemoteUpdateNotRecordedTest: TestDefinition = {
    description:
        "Client 0 sends two rapid updates. Client 1 processes both, then disconnects and reconnects. Both clients should still converge to the latest content after reconnect.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "update", client: 0, path: "doc.md", content: "update 1" },
        { type: "sync", client: 0 },
        { type: "update", client: 0, path: "doc.md", content: "update 2" },

        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("doc.md", "update 2");
            }
        },

        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("doc.md", "update 2");
            }
        }
    ]
};
