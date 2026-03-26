import type { TestDefinition } from "../test-definition";

export const writeWriteConflictTest: TestDefinition = {
    name: "Write/Write Conflict",
    description:
        "Two clients simultaneously create the same file with different content. " +
        "Both contributions should be preserved in the merged result without duplication.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "hello" },
        { type: "create", client: 1, path: "A.md", content: "hello" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (state) => {
                state
                    .assertFileCount(1)
                    .assertContent("A.md", "hello")
            }
        }
    ]
};
