import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineEditThenMoveSameContentTest: TestDefinition = {
    description:
        "A file is renamed and edited to match a deleted file's content. Both clients must converge despite the ambiguity.",
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
        { type: "barrier" },

        { type: "disable-sync", client: 0 },

        { type: "delete", client: 0, path: "A.md" },

        { type: "rename", client: 0, oldPath: "B.md", newPath: "C.md" },

        {
            type: "update",
            client: 0,
            path: "C.md",
            content: "content A"
        },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileNotExists("A.md")
                    .assertFileNotExists("B.md")
                    .assertContent("C.md", "content A")
                    .assertFileCount(1);
            }
        }
    ]
};
