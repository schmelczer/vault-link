import type { TestDefinition } from "../test-definition";

export const interleavedOperationsTest: TestDefinition = {
    name: "Interleaved Create-Update-Delete Across Clients",
    description:
        "Client 0 creates files A, B, C. Client 1 syncs. Then Client 0 deletes A, " +
        "Client 1 updates B, Client 0 renames C to D — all interleaved. " +
        "Both should converge to the same final state.",
    clients: 2,
    steps: [
        // Setup: create 3 files
        { type: "create", client: 0, path: "A.md", content: "aaa" },
        { type: "create", client: 0, path: "B.md", content: "bbb" },
        { type: "create", client: 0, path: "C.md", content: "ccc" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Interleaved operations (both clients online)
        { type: "delete", client: 0, path: "A.md" },
        { type: "update", client: 1, path: "B.md", content: "bbb-updated" },
        { type: "rename", client: 0, oldPath: "C.md", newPath: "D.md" },

        { type: "sync" },
        { type: "barrier" },

        // A.md deleted, B.md updated, C.md renamed to D.md
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-exists", client: 0, path: "B.md" },
        { type: "assert-exists", client: 1, path: "B.md" },
        { type: "assert-not-exists", client: 0, path: "C.md" },
        { type: "assert-not-exists", client: 1, path: "C.md" },
        { type: "assert-exists", client: 0, path: "D.md" },
        { type: "assert-exists", client: 1, path: "D.md" },
        { type: "assert-consistent" }
    ]
};
