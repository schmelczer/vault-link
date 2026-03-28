import type { TestDefinition } from "../test-definition";

export const moveAndConcurrentRemoteUpdateTest: TestDefinition = {
    description:
        "Client 0 renames A.md to B.md offline while client 1 updates A.md. " +
        "After client 0 reconnects, both should have B.md with client 1's updated content.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "original content"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },

        {
            type: "update",
            client: 1,
            path: "A.md",
            content: "updated by client 1"
        },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(1).assertFileNotExists("A.md").assertContains("B.md", "updated by client 1") }
    ]
};
