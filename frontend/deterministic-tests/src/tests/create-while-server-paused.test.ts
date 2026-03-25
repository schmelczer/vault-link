import type { TestDefinition } from "../test-definition";

export const createWhileServerPausedTest: TestDefinition = {
    name: "Create While Server Paused Then Resume",
    description:
        "Server is paused. Client 0 creates a file (request will stall). " +
        "Then server resumes. File should sync to Client 1.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Pause server first, then create
        { type: "pause-server" },
        { type: "create", client: 0, path: "paused-create.md", content: "created during pause" },
        { type: "resume-server" },

        { type: "sync" },
        { type: "barrier" },

        { type: "assert-exists", client: 0, path: "paused-create.md" },
        { type: "assert-exists", client: 1, path: "paused-create.md" },
        {
            type: "assert-content",
            client: 1,
            path: "paused-create.md",
            content: "created during pause"
        },
        { type: "assert-consistent" }
    ]
};
