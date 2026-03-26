import type { TestDefinition } from "../test-definition";

export const coalesceUpdateRemoteUpdateDataLossTest: TestDefinition = {
    name: "Local and remote edits to the same file are both preserved",
    description:
        "Client 0 edits a file while client 1 is offline. Client 1 reconnects " +
        "and immediately edits the same file. Both edits should be preserved.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "line 1\nline 2\nline 3"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "line 1\nline 2\nline 3\nclient 0 addition"
        },
        { type: "sync", client: 0 },

        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "client 1 addition\nline 1\nline 2\nline 3"
        },

        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state) => {
                state
                    .assertFileCount(1)
                    .assertContains("doc.md", "client 0 addition", "client 1 addition");
            }
        }
    ]
};
