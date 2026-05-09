import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const createRenameCreateSamePathTest: TestDefinition = {
    description:
        "Client creates A.md, renames to B.md, creates new A.md, renames " +
        "to C.md, creates yet another A.md. All three files should exist " +
        "as separate documents on both clients.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "first file" },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },

        { type: "create", client: 0, path: "A.md", content: "second file" },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "C.md" },

        { type: "create", client: 0, path: "A.md", content: "third file" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertFileCount(3)
                    .assertContent("B.md", "first file")
                    .assertContent("C.md", "second file")
                    .assertContent("A.md", "third file");
            }
        }
    ]
};
