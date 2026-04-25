import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const rapidUpdatesAfterMergeTest: TestDefinition = {
    description:
        "Both clients create the same file offline, triggering a merge on sync. " +
        "Client 0 then rapidly sends three updates. Both clients must converge to the final update.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "from client 0" },
        { type: "create", client: 1, path: "doc.md", content: "from client 1" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "update 1"
        },
        { type: "sync", client: 0 },

        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "update 2"
        },
        { type: "sync", client: 0 },

        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "update 3"
        },
        { type: "sync", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContains("doc.md", "update 3");
            }
        }
    ]
};
