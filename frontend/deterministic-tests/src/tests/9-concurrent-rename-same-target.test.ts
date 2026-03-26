import type { TestDefinition } from "../test-definition";

export const concurrentRenameSameTargetTest: TestDefinition = {
    name: "Two clients rename different files to the same target path",
    description:
        "One client renames A to C while the other renames B to C, both offline. " +
        "After syncing, both file contents should be preserved via path deconfliction.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        { type: "rename", client: 0, oldPath: "A.md", newPath: "C.md" },
        { type: "sync", client: 0 },

        { type: "rename", client: 1, oldPath: "B.md", newPath: "C.md" },

        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state) => {
                state
                    .assertFileCount(2)
                    .assertFileNotExists("A.md")
                    .assertFileNotExists("B.md")
                    .assertFileExists("C.md")
                    .assertFileExists("C (1).md")
                    .assertAnyFileContains("content-a", "content-b");
            }
        }
    ]
};
