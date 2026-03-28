import type { TestDefinition } from "../test-definition";

export const deleteDuringPendingCreateTest: TestDefinition = {
    description:
        "Client 0 creates a file while the server is paused, then deletes it before the server resumes. " +
        "After resume, the file should end up deleted on both clients.",
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
            path: "ephemeral.md",
            content: "this will be deleted"
        },

        { type: "delete", client: 0, path: "ephemeral.md" },

        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(0).assertFileNotExists("ephemeral.md") }
    ]
};
