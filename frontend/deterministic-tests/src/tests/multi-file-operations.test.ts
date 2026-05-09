import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const multiFileOperationsTest: TestDefinition = {
    description:
        "Client 0 deletes A.md while client 1 is offline. Client 1 updates B.md " +
        "and renames its stale A.md to D.md offline. After client 1 reconnects, " +
        "B.md must hold client 1's update, C.md must be unchanged, A.md must be " +
        "gone, and the offline-renamed file must be preserved at D.md (post as " +
        "a new doc since A.md was deleted server-side).",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "create", client: 0, path: "C.md", content: "content-c" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
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
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                // Pin B.md/C.md/D.md exactly: a regression that loses
                // client 1's offline rename (no D.md) or that drops the
                // B.md update would otherwise pass the loose checks.
                s.assertFileCount(3)
                    .assertContent("B.md", "updated by client 1")
                    .assertContent("C.md", "content-c")
                    .assertContent("D.md", "content-a")
                    .assertFileNotExists("A.md");
            }
        }
    ]
};
