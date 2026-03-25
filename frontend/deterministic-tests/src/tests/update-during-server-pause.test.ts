import type { TestDefinition } from "../test-definition";

export const updateDuringServerPauseTest: TestDefinition = {
    name: "Update During Server Pause",
    description:
        "Client 0 creates a file and syncs. Server is paused. Client 0 updates " +
        "the file (request stalls). Server resumes. The update should eventually " +
        "propagate to Client 1.",
    clients: 2,
    steps: [
        // Setup: create and sync
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "create", client: 0, path: "doc.md", content: "v1" },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "doc.md", content: "v1" },

        // Pause server, update file
        { type: "pause-server" },
        { type: "update", client: 0, path: "doc.md", content: "v2 during pause" },

        // Resume server
        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        // Both should have updated content
        {
            type: "assert-content",
            client: 0,
            path: "doc.md",
            content: "v2 during pause"
        },
        {
            type: "assert-content",
            client: 1,
            path: "doc.md",
            content: "v2 during pause"
        },
        { type: "assert-consistent" }
    ]
};
