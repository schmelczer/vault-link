import type { TestDefinition } from "../test-definition";

export const multipleUpdatesCoalesceTest: TestDefinition = {
    name: "Multiple Rapid Updates Converge to Final Version",
    description:
        "Client 0 rapidly updates a file multiple times while online. " +
        "Both clients must converge to the final content.",
    clients: 2,
    steps: [
        // Setup: create file and sync
        { type: "create", client: 0, path: "rapid.md", content: "v0" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "rapid.md", content: "v0" },

        // Client 0 rapidly updates (sync is enabled, so events are enqueued)
        { type: "update", client: 0, path: "rapid.md", content: "v1" },
        { type: "update", client: 0, path: "rapid.md", content: "v2" },
        { type: "update", client: 0, path: "rapid.md", content: "v3" },
        { type: "update", client: 0, path: "rapid.md", content: "v4-final" },

        // Sync and converge
        { type: "sync" },
        { type: "barrier" },

        // Both should have the final version
        {
            type: "assert-content",
            client: 0,
            path: "rapid.md",
            content: "v4-final"
        },
        {
            type: "assert-content",
            client: 1,
            path: "rapid.md",
            content: "v4-final"
        },
        { type: "assert-consistent" }
    ]
};
