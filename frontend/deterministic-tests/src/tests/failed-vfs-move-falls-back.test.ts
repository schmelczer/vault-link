import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const failedVfsMoveFallsBackTest: TestDefinition = {
    description:
        "File A is renamed to B's path (overwriting B). Both clients " +
        "should converge on a single file at B.md with A's content.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content A" },
        { type: "create", client: 0, path: "B.md", content: "content B" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("B.md", "content A");
            }
        }
    ]
};
