import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const concurrentDeleteDuringRemoteUpdateTest: TestDefinition = {
    description:
        "One client updates a file while the other deletes it at the same " +
        "time. Both clients should converge without errors.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "update", client: 0, path: "doc.md", content: "updated by 0" },
        { type: "delete", client: 1, path: "doc.md" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(0);
            }
        }
    ]
};
