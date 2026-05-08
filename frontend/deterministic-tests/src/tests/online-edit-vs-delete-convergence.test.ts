import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const onlineEditVsDeleteConvergenceTest: TestDefinition = {
    description:
        "Both clients are online. Client 0 edits a file while client 1 " +
        "deletes it. The clients must converge to the same state.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "update",
            client: 0,
            path: "A.md",
            content: "edited by client 0"
        },
        { type: "delete", client: 1, path: "A.md" },

        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(0);
            }
        }
    ]
};
