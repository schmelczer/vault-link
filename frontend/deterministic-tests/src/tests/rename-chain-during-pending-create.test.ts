import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renameChainDuringPendingCreateTest: TestDefinition = {
    description:
        "Hold a create before sending it, then rename its document twice. Both clients must retain the original bytes at the final path.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "hold-request", client: 0, kind: "create", point: "before" },

        { type: "create", client: 0, path: "first.md", content: "v1\n" },
        { type: "wait-for-request", client: 0 },
        {
            type: "rename",
            client: 0,
            oldPath: "first.md",
            newPath: "second.md"
        },
        {
            type: "rename",
            client: 0,
            oldPath: "second.md",
            newPath: "third.md"
        },

        { type: "release-request", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(1);
                state.assertFileExists("third.md");
                state.assertContent("third.md", "v1\n");
            }
        }
    ]
};
