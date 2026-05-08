import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const deleteByOtherClientThenRecreateTest: TestDefinition = {
    description:
        "Client 1 deletes a file and the delete propagates. Then client 0 " +
        "creates a new file at the same path. Both clients must have the file.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "delete", client: 1, path: "A.md" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileNotExists("A.md");
            }
        },

        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "recreated by client 0"
        },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("A.md", "recreated by client 0");
            }
        }
    ]
};
