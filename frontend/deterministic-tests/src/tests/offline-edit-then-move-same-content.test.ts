import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineEditThenMoveSameContentTest: TestDefinition = {
    description:
        "Single-client offline sequence on Client 0: delete A.md, rename " +
        "B.md to C.md, then update C.md so its content equals the deleted " +
        "A.md's content. The ambiguity is for the engine: the resulting " +
        "C.md content matches a doc that was just deleted, but it must " +
        "still be tracked as the renamed-from-B doc, not resurrected as A. " +
        "Both clients must converge to a single C.md with 'content A'.",
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
