import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const concurrentRenameAndCreateAtTargetCreateFirstTest: TestDefinition =
    {
        description:
            "One client renames X to Y while another creates a new file at Y, " +
            "both offline. After syncing, Y should contain merged content from " +
            "both the renamed file and the newly created file.",
        clients: 2,
        steps: [
            {
                type: "create",
                client: 0,
                path: "X.md",
                content: "original file X"
            },
            { type: "enable-sync", client: 0 },
            { type: "enable-sync", client: 1 },
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

            { type: "enable-sync", client: 1 },
            { type: "sync", client: 1 },

            { type: "enable-sync", client: 0 },
            { type: "barrier" },

            {
                type: "assert-consistent",
                verify: (state: AssertableState): void => {
                    state
                        .assertFileCount(2)
                        .assertContains("Y (1).md", "original file X")
                        .assertContains("Y.md", "brand new Y content");
                }
            }
        ]
    };
