import type { TestDefinition } from "../test-definition";

export const mcCrossCreateRenameSameTargetTest: TestDefinition = {
    description:
        "Client 0 creates X.md, Client 1 creates Y.md. Both sync. Client 0 renames " +
        "X.md -> Z.md. Client 1 (offline) renames Y.md -> Z.md. Both must converge " +
        "with both contents preserved via path deconfliction.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "X.md", content: "content-x" },
        { type: "create", client: 1, path: "Y.md", content: "content-y" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) => s.assertFileExists("X.md").assertFileExists("Y.md")
        },

        { type: "disable-sync", client: 1 },

        { type: "rename", client: 0, oldPath: "X.md", newPath: "Z.md" },
        { type: "sync", client: 0 },

        { type: "rename", client: 1, oldPath: "Y.md", newPath: "Z.md" },

        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) => {
                s.assertFileCount(2)
                    .assertFileNotExists("X.md")
                    .assertFileNotExists("Y.md")
                    .assertFileExists("Z.md")
                    .assertAnyFileContains("content-x", "content-y");
            }
        }
    ]
};
