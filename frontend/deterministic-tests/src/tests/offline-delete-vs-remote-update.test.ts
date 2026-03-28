import type { TestDefinition } from "../test-definition";

export const offlineDeleteVsRemoteUpdateTest: TestDefinition = {
    description:
        "Client 0 deletes A.md offline while client 1 updates it. Both clients must converge.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "original content"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s) => s.assertContent("A.md", "original content")
        },

        { type: "disable-sync", client: 0 },
        { type: "delete", client: 0, path: "A.md" },

        {
            type: "update",
            client: 1,
            path: "A.md",
            content: "important update by client 1"
        },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) => s.assertFileCount(0)
        }
    ]
};
