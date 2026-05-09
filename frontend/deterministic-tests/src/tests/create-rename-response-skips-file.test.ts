import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const createRenameResponseSkipsFileTest: TestDefinition = {
    description:
        "Client 0 creates a file online then immediately renames it. " +
        "Client 1 must receive the file content at the renamed path.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "the-content"
        },

        {
            type: "rename",
            client: 0,
            oldPath: "doc.md",
            newPath: "renamed.md"
        },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                // The rename must land at renamed.md on both clients.
                // assertAnyFileContains alone would have passed even if
                // the rename were dropped server-side and both clients
                // converged on doc.md with "the-content".
                s.assertFileCount(1)
                    .assertContent("renamed.md", "the-content")
                    .assertFileNotExists("doc.md");
            }
        }
    ]
};
