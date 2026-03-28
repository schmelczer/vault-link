import type { TestDefinition } from "../test-definition";

export const renameToPathOfUnconfirmedDeleteTest: TestDefinition = {
    description:
        "Client 0 deletes A.md and renames B.md to A.md while offline. After reconnecting, A.md should exist with B's content and B.md should be gone.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "content A"
        },
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "content B"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },

        { type: "delete", client: 0, path: "A.md" },
        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s
                    .assertFileCount(1)
                    .assertFileNotExists("B.md")
                    .assertContent("A.md", "content B"),
        }
    ]
};
