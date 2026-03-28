import type { TestDefinition } from "../test-definition";

export const simultaneousCreateDeleteSamePathTest: TestDefinition = {
    description:
        "Client 0 creates A.md and syncs to both clients. Client 0 deletes A.md while " +
        "Client 1 (offline) updates A.md with different content. When Client 1 reconnects, " +
        "the update and delete must be reconciled. Both clients must converge.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original from 0" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        { type: "delete", client: 0, path: "A.md" },
        { type: "sync", client: 0 },

        { type: "update", client: 1, path: "A.md", content: "modified by 1 while offline" },

        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) => {
                s.ifFileExists("A.md", (s) =>
                    s.assertFileCount(1).assertContent("A.md", "modified by 1 while offline")
                );
                if (!s.files.has("A.md")) {
                    s.assertFileCount(0);
                }
            },
        }
    ]
};
