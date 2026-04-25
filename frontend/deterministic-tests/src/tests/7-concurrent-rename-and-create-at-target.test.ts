import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const concurrentRenameAndCreateAtTargetTest: TestDefinition = {
    description:
        "One client renames X to Y while another creates a new file at Y, " +
        "both offline. We can't merge the create because it would result in a cycle",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "X.md",
            content: "original file X"
        },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "rename", client: 0, oldPath: "X.md", newPath: "Y.md" },

        {
            type: "create",
            client: 1,
            path: "Y.md",
            content: "brand new Y content"
        },

        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },

        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertFileNotExists("X.md")
                    .assertFileExists(
                        "Y.md",
                    )
                    .assertFileExists(
                        "Y (1).md",
                    )
                    .assertAnyFileContains("original file X", "brand new Y content")
            }
        }
    ]
};
