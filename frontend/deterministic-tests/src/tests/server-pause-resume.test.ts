import type { TestDefinition } from "../test-definition";

export const serverPauseResumeTest: TestDefinition = {
    name: "Server Pause and Resume",
    description:
        "Client 0 creates a file and syncs it to the server. The server is then " +
        "paused (SIGSTOP), which may stall WebSocket broadcasts to Client 1. " +
        "After the server resumes, both clients should converge.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        // Create a file, then immediately pause the server
        { type: "create", client: 0, path: "resilient.md", content: "survives pause" },
        { type: "pause-server" },
        { type: "resume-server" },

        // After resume, sync should eventually succeed
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-exists", client: 0, path: "resilient.md" },
        { type: "assert-exists", client: 1, path: "resilient.md" },
        {
            type: "assert-content",
            client: 0,
            path: "resilient.md",
            content: "survives pause"
        },
        {
            type: "assert-content",
            client: 1,
            path: "resilient.md",
            content: "survives pause"
        },
        { type: "assert-consistent" }
    ]
};
