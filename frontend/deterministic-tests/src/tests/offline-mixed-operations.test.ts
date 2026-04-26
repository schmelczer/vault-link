import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineMixedOperationsTest: TestDefinition = {
    description:
        "Client 0 creates 3 files, syncs to both clients. Client 0 goes offline, " +
        "deletes file 1, renames file 2 to a new name, and edits file 3. " +
        "When Client 0 reconnects, all three operations should propagate to Client 1.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "file1.md", content: "content-1" },
        { type: "create", client: 0, path: "file2.md", content: "content-2" },
        { type: "create", client: 0, path: "file3.md", content: "content-3" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("file1.md", "content-1")
                    .assertContent("file2.md", "content-2")
                    .assertContent("file3.md", "content-3");
            }
        },

        { type: "disable-sync", client: 0 },

        { type: "delete", client: 0, path: "file1.md" },
        {
            type: "rename",
            client: 0,
            oldPath: "file2.md",
            newPath: "moved.md"
        },
        {
            type: "update",
            client: 0,
            path: "file3.md",
            content: "updated-content-3"
        },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileNotExists("file1.md")
                    .assertFileNotExists("file2.md")
                    .assertContent("moved.md", "content-2")
                    .assertContent("file3.md", "updated-content-3")
                    .assertFileCount(2);
            }
        }
    ]
};
