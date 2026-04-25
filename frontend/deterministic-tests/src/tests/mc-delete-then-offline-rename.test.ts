import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const mcDeleteThenOfflineRenameTest: TestDefinition = {
    description:
        "Client 0 creates A.md, both sync. Client 1 goes offline. Client 0 deletes " +
        "A.md and syncs. Client 1 (offline) renames A.md to B.md. Client 1 reconnects. " +
        "Both must converge. C.md (unrelated) must be unaffected.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "create", client: 0, path: "C.md", content: "unrelated" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        { type: "delete", client: 0, path: "A.md" },
        { type: "sync", client: 0 },

        { type: "rename", client: 1, oldPath: "A.md", newPath: "B.md" },

        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("C.md", "unrelated").assertFileNotExists(
                    "A.md"
                );
                s.ifFileExists("B.md", (inner) =>
                    inner.assertContent("B.md", "original")
                );
            }
        }
    ]
};
