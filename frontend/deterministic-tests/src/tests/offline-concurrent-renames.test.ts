import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineConcurrentRenamesTest: TestDefinition = {
    description:
        "Client 0 creates A.md and syncs to both clients. Both clients go offline. " +
        "Client 0 renames A.md to B.md. Client 1 renames A.md to C.md. " +
        "Both reconnect. The system must converge -- both clients should " +
        "agree on the final state and the content must not be lost.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "shared-content" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("A.md", "shared-content");
            }
        },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        {
            type: "rename",
            client: 0,
            oldPath: "A.md",
            newPath: "B.md"
        },

        {
            type: "rename",
            client: 1,
            oldPath: "A.md",
            newPath: "C.md"
        },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileNotExists("A.md")
                    .assertFileCount(1)
                    .assertAnyFileContains("shared-content");
                s.ifFileExists("B.md", (inner) =>
                    inner.assertContent("B.md", "shared-content")
                );
                s.ifFileExists("C.md", (inner) =>
                    inner.assertContent("C.md", "shared-content")
                );
            }
        }
    ]
};
