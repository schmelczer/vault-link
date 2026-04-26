import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineMoveThenRemoteDeleteTest: TestDefinition = {
    description:
        "Client 0 renames A.md to B.md offline while client 1 deletes A.md. " +
        "Both clients must converge to having no files.",
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
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },

        { type: "delete", client: 1, path: "A.md" },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileNotExists("A.md")
                    .assertFileNotExists("B.md")
                    .assertFileCount(0);
            }
        }
    ]
};
