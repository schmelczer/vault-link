import type { TestDefinition } from "../test-definition";

export const localEditLostDuringCreateMergeTest: TestDefinition = {
    description:
        "Both clients create doc.md with different content while offline. " +
        "Client 0 also edits the file before syncing. After both connect, " +
        "the merged result should contain content from both clients.",
    clients: 2,
    steps: [
        { type: "create", client: 1, path: "doc.md", content: "from-client-1" },
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "from-client-0"
        },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "local-edit-during-create"
        },

        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertFileCount(1).assertContains(
                    "doc.md",
                    "from-client-1",
                    "local-edit-during-create"
                ),
        }
    ]
};
