import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const multiFileOperationsTest: TestDefinition = {
    description:
        "Client 0 deletes A.md while client 1 is offline. Client 1 updates B.md and renames A.md to D.md offline. " +
        "After client 1 reconnects, both clients must converge with B.md updated and C.md intact.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "create", client: 0, path: "C.md", content: "content-c" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        { type: "delete", client: 0, path: "A.md" },
        { type: "sync", client: 0 },

        {
            type: "update",
            client: 1,
            path: "B.md",
            content: "updated by client 1"
        },
        { type: "rename", client: 1, oldPath: "A.md", newPath: "D.md" },

        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContains("B.md", "updated")
                    .assertFileExists("C.md")
                    .assertFileNotExists("A.md");
                s.ifFileExists("D.md", (inner) =>
                    inner.assertContent("D.md", "content-a")
                );
            }
        }
    ]
};
