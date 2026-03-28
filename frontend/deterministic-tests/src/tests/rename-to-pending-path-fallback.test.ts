import type { TestDefinition } from "../test-definition";

export const renameToPendingPathFallbackTest: TestDefinition = {
    description:
        "Client 0 creates B.md and syncs. Goes offline, creates A.md, then renames B.md to A.md (overwriting the unsynced A). After reconnecting, B.md should be gone and A.md should have B's content.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "B.md", content: "tracked B content" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },

        { type: "create", client: 0, path: "A.md", content: "pending A content" },

        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertFileNotExists("B.md").assertContains("A.md", "tracked B content"),
        }
    ]
};
