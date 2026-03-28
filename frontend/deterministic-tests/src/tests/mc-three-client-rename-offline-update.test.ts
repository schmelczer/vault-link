import type { TestDefinition } from "../test-definition";

export const mcThreeClientRenameOfflineUpdateTest: TestDefinition = {
    description:
        "Client 0 creates A.md. Client 1 renames to B.md. Client 2 (offline) " +
        "updates A.md. All three converge with updated content at B.md.",
    clients: 3,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "enable-sync", client: 2 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 2 },

        { type: "rename", client: 1, oldPath: "A.md", newPath: "B.md" },
        { type: "sync", client: 1 },
        { type: "sync", client: 0 },

        { type: "update", client: 2, path: "A.md", content: "updated-by-client-2" },

        { type: "enable-sync", client: 2 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(1).assertFileNotExists("A.md").assertContains("B.md", "updated-by-client-2") }
    ]
};
