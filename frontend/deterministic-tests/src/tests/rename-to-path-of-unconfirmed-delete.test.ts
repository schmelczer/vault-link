import type { TestDefinition } from "../test-definition";

export const renameToPathOfUnconfirmedDeleteTest: TestDefinition = {
    description:
        "Client 0 deletes A.md then renames B.md to A.md. After syncing, " +
        "B's content should exist and the old A.md content should be gone. " +
        "The server may deconflict the path if the delete and move arrive " +
        "in the same transaction.",
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

        { type: "delete", client: 0, path: "A.md" },
        { type: "barrier" },

        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s
                    .assertFileNotExists("B.md")
                    .assertContains("A.md", "content B"),
        }
    ]
};
