import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renameToRecentlyDeletedPathTest: TestDefinition = {
    description:
        "Client 0 deletes B.md. Client 1 renames A.md to B.md offline. After reconnecting, only B.md should exist with A's content.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        { type: "delete", client: 0, path: "B.md" },
        { type: "sync", client: 0 },

        {
            type: "rename",
            client: 1,
            oldPath: "A.md",
            newPath: "B.md"
        },

        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1)
                    .assertFileNotExists("A.md")
                    .assertContent("B.md", "content-a");
            }
        }
    ]
};
