import type { TestDefinition } from "../test-definition";

export const renameChainTest: TestDefinition = {
    name: "Rename Chain",
    description:
        "Client 0 (offline) creates A.md, renames to B.md, then renames to C.md. " +
        "When sync is enabled, only C.md should exist. Client 1 should receive C.md " +
        "with the original content. Intermediate paths should never appear.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 1 },

        // Client 0 creates and renames while offline
        { type: "create", client: 0, path: "A.md", content: "important content" },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "rename", client: 0, oldPath: "B.md", newPath: "C.md" },

        // Enable sync — reconciliation discovers C.md as a new file
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Only C.md should exist on both clients
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 0, path: "B.md" },
        { type: "assert-exists", client: 0, path: "C.md" },
        { type: "assert-content", client: 0, path: "C.md", content: "important content" },

        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "B.md" },
        { type: "assert-exists", client: 1, path: "C.md" },
        { type: "assert-content", client: 1, path: "C.md", content: "important content" },

        { type: "assert-consistent" }
    ]
};
