import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renameToExistingPathTest: TestDefinition = {
    description:
        "Client 0 has A.md and B.md. Client 0 renames A.md to B.md (overwriting B.md). " +
        "Both clients should converge: A.md gone, B.md has A.md's content.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "alpha" },
        { type: "create", client: 0, path: "B.md", content: "beta" },
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
                s.assertFileNotExists("A.md").assertContent("B.md", "alpha");
            }
        }
    ]
};
