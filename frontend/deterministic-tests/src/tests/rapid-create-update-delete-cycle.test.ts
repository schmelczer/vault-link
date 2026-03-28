import type { TestDefinition } from "../test-definition";

export const rapidCreateUpdateDeleteCycleTest: TestDefinition = {
    description:
        "Client 0 rapidly creates, updates, deletes, then re-creates a file while the server is paused. " +
        "After the server resumes, client 1 must see only the final file.",
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
            path: "cycle.md",
            content: "version 1"
        },
        {
            type: "update",
            client: 0,
            path: "cycle.md",
            content: "version 2"
        },
        { type: "delete", client: 0, path: "cycle.md" },

        {
            type: "create",
            client: 0,
            path: "cycle.md",
            content: "final creation"
        },

        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) => s.assertFileCount(1).assertContent("cycle.md", "final creation"),
        }
    ]
};
