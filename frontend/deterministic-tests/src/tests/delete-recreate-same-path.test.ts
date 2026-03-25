import type { TestDefinition } from "../test-definition";

export const deleteRecreateSamePathTest: TestDefinition = {
    name: "Delete Then Recreate at Same Path",
    description:
        "Client 0 creates A.md, syncs. Then deletes A.md and creates a new A.md " +
        "with different content. Both clients should converge on the new content.",
    clients: 2,
    steps: [
        // Setup: create and sync A.md
        { type: "create", client: 0, path: "A.md", content: "version 1" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "A.md", content: "version 1" },

        // Client 0 deletes then recreates A.md with new content
        { type: "disable-sync", client: 0 },
        { type: "delete", client: 0, path: "A.md" },
        { type: "create", client: 0, path: "A.md", content: "version 2" },
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should have the new content
        { type: "assert-exists", client: 0, path: "A.md" },
        { type: "assert-exists", client: 1, path: "A.md" },
        {
            type: "assert-content",
            client: 0,
            path: "A.md",
            content: "version 2"
        },
        {
            type: "assert-content",
            client: 1,
            path: "A.md",
            content: "version 2"
        },
        { type: "assert-consistent" }
    ]
};
