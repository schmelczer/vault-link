import type { TestDefinition } from "../test-definition";

export const keyMigrationEventDropTest: TestDefinition = {
    description:
        "Client 0 creates a file and immediately updates it while the server is paused. " +
        "After resume, both clients should have the updated content.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "pause-server" },

        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "initial content"
        },
        {
            type: "update",
            client: 0,
            path: "A.md",
            content: "updated content"
        },

        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(1).assertContent("A.md", "updated content") }
    ]
};
