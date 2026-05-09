import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renameToPendingPathFallbackTest: TestDefinition = {
    description:
        "Client 0 creates B.md and syncs. Goes offline, creates A.md, then renames B.md to A.md (overwriting the unsynced A). After reconnecting, B.md should be gone and A.md should have B's content.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "tracked B content"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },

        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "pending A content"
        },

        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                // The rename clobbers the unsynced A.md on disk, so the
                // expected post-converge state is exactly one file at A.md
                // with the renamed-from-B content. A regression that
                // produced a deconflicted A (1).md carrying the lost
                // "pending A content" would slip past assertContains.
                s.assertFileNotExists("B.md")
                    .assertFileCount(1)
                    .assertContent("A.md", "tracked B content");
            }
        }
    ]
};
