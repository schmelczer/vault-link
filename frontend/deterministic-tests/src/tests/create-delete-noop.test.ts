import type { TestDefinition } from "../test-definition";

export const createDeleteNoopTest: TestDefinition = {
    name: "Create-Delete Noop",
    description:
        "Client 0 (offline) creates a file, updates it multiple times, then deletes it. " +
        "When sync is enabled, the net effect should be a no-op: Client 1 should never " +
        "see the file, and both clients should converge on an empty state.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 1 },

        // Client 0 performs create → update → update → delete while offline
        { type: "create", client: 0, path: "temp.md", content: "version 1" },
        { type: "update", client: 0, path: "temp.md", content: "version 2" },
        { type: "update", client: 0, path: "temp.md", content: "version 3" },
        { type: "delete", client: 0, path: "temp.md" },

        // Enable sync — reconciliation should find nothing to do
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Neither client should have the file
        { type: "assert-not-exists", client: 0, path: "temp.md" },
        { type: "assert-not-exists", client: 1, path: "temp.md" },
        { type: "assert-consistent" }
    ]
};
