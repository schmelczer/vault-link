import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renameUpdateConflictTest: TestDefinition = {
    description:
        "Client 0 renames A.md to B.md while client 1 updates A.md offline. After client 1 reconnects, both should converge with the update at B.md.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("A.md", "original");
            }
        },

        { type: "disable-sync", client: 1 },

        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "sync", client: 0 },

        {
            type: "update",
            client: 1,
            path: "A.md",
            content: "updated by client 1"
        },

        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileNotExists("A.md").assertContains("B.md", "updated");
            }
        }
    ]
};
