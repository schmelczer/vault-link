import type { TestDefinition } from "../test-definition";

export const deleteNonexistentFileTest: TestDefinition = {
    name: "Delete Propagation",
    description:
        "Both clients have A.md. Client 0 deletes it and syncs. Client 1 receives " +
        "the delete via broadcast. Both clients should converge on an empty state.",
    clients: 2,
    steps: [
        // Setup: create and sync
        { type: "create", client: 0, path: "A.md", content: "ephemeral" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 deletes and syncs
        { type: "delete", client: 0, path: "A.md" },
        { type: "sync" },
        { type: "barrier" },

        // Both should agree A.md is gone
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-consistent" }
    ]
};
