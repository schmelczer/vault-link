import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const deleteRecreateSamePathTest: TestDefinition = {
    description:
        "Client 0 creates A.md, syncs. Then deletes A.md and creates a new A.md " +
        "with different content. Both clients should converge on the new content.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "version 1" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("A.md", "version 1");
            }
        },

        { type: "disable-sync", client: 0 },
        { type: "delete", client: 0, path: "A.md" },
        { type: "create", client: 0, path: "A.md", content: "version 2" },
        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("A.md", "version 2");
            }
        }
    ]
};
