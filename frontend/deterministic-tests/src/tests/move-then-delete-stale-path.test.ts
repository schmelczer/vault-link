import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const moveThenDeleteStalePathTest: TestDefinition = {
    description:
        "Client 0 renames A.md to B.md and immediately deletes B.md. " +
        "Both clients should end up with zero files.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "content to delete"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "delete", client: 0, path: "B.md" },

        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(0)
                    .assertFileNotExists("A.md")
                    .assertFileNotExists("B.md");
            }
        }
    ]
};
