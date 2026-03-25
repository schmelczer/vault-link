import type { TestDefinition } from "../test-definition";

export const rapidSyncToggleTest: TestDefinition = {
    name: "Rapid Sync Toggle",
    description:
        "Client 0 creates a file, then toggles sync off and on multiple times. " +
        "The file should eventually sync to Client 1 without deadlocks or data loss.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 1 },

        // Create a file while offline
        { type: "create", client: 0, path: "stable.md", content: "must survive toggles" },

        // Toggle sync on client 0 multiple times
        { type: "enable-sync", client: 0 },
        { type: "disable-sync", client: 0 },
        { type: "enable-sync", client: 0 },
        { type: "disable-sync", client: 0 },

        // Final enable — this one must succeed
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-exists", client: 0, path: "stable.md" },
        { type: "assert-exists", client: 1, path: "stable.md" },
        {
            type: "assert-content",
            client: 1,
            path: "stable.md",
            content: "must survive toggles"
        },
        { type: "assert-consistent" }
    ]
};
