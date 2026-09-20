import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renameCreateConflictTest: TestDefinition = {
    description:
        "Client 0 creates A.md and syncs. Client 1 renames A.md to B.md and syncs. Client 0 (offline) creates B.md with the same content. After reconnecting, both clients should converge with only B.md.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "create", client: 0, path: "A.md", content: "hi" },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("A.md", "hi");
            }
        },
        { type: "disable-sync", client: 0 },
        { type: "rename", client: 1, oldPath: "A.md", newPath: "B.md" },
        { type: "sync", client: 1 },
        { type: "create", client: 0, path: "B.md", content: "hi" },
        { type: "enable-sync", client: 0 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(2)
                    .assertContent("B.md", "hi")
                    .assertContent(s.conflictPath("B.md"), "hi");
            }
        }
    ]
};
