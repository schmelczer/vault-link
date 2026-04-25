import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const createMergePreservesRenamedUpdateTest: TestDefinition = {
    description:
        "Both clients create the same file, which gets merged. One client goes " +
        "offline, renames the file, updates it, and creates a new file at the " +
        "original path. After reconnecting, the updated content must be preserved.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "alpha" },
        { type: "create", client: 1, path: "doc.md", content: "beta" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        {
            type: "rename",
            client: 1,
            oldPath: "doc.md",
            newPath: "moved.md"
        },
        {
            type: "update",
            client: 1,
            path: "moved.md",
            content: "alpha beta extra-update"
        },

        {
            type: "create",
            client: 1,
            path: "doc.md",
            content: "new-content"
        },

        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertContent("moved.md", "alpha beta extra-update")
                    .assertContent("doc.md", "new-content");
            }
        }
    ]
};
