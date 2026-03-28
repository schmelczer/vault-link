import type { TestDefinition } from "../test-definition";

export const threeClientRenameCreateDeleteTest: TestDefinition = {
    description:
        "Client 0 renames X→Y, Client 1 deletes X, Client 2 creates Y. " +
        "All three operations happen while the other clients are offline. " +
        "Tests that the system handles the three-way conflict and converges.",
    clients: 3,
    steps: [
        {
            type: "create",
            client: 0,
            path: "X.md",
            content: "original from A"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "enable-sync", client: 2 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "disable-sync", client: 2 },

        { type: "rename", client: 0, oldPath: "X.md", newPath: "Y.md" },

        { type: "delete", client: 1, path: "X.md" },

        {
            type: "create",
            client: 2,
            path: "Y.md",
            content: "new from C"
        },

        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },

        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 2 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s
                    .assertFileNotExists("X.md")
                    .assertContains("Y.md", "original from A", "new from C"),
        }
    ]
};
