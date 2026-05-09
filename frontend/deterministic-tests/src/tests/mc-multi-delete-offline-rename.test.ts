import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const mcMultiDeleteOfflineRenameTest: TestDefinition = {
    description:
        "Client 0 creates 5 files. Client 1 deletes 2 while Client 0 (offline) " +
        "renames one of the deleted files. Both must converge.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "file-1.md", content: "content-1" },
        { type: "create", client: 0, path: "file-2.md", content: "content-2" },
        { type: "create", client: 0, path: "file-3.md", content: "content-3" },
        { type: "create", client: 0, path: "file-4.md", content: "content-4" },
        { type: "create", client: 0, path: "file-5.md", content: "content-5" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },

        { type: "delete", client: 1, path: "file-2.md" },
        { type: "delete", client: 1, path: "file-4.md" },
        { type: "sync", client: 1 },

        {
            type: "rename",
            client: 0,
            oldPath: "file-2.md",
            newPath: "renamed.md"
        },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileExists("file-1.md")
                    .assertFileExists("file-3.md")
                    .assertFileExists("file-5.md")
                    .assertFileNotExists("file-2.md")
                    .assertFileNotExists("file-4.md");
                // The offline rename of a remotely-deleted file must
                // preserve "content-2" somewhere — either at renamed.md
                // or as a deconflict.
                s.assertAnyFileContains("content-2");
                s.ifFileExists("renamed.md", (inner) =>
                    inner.assertContent("renamed.md", "content-2")
                );
            }
        }
    ]
};
