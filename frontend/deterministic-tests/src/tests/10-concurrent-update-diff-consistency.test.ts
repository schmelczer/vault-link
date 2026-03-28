import type { TestDefinition } from "../test-definition";

export const concurrentUpdateDiffConsistencyTest: TestDefinition = {
    description:
        "Both clients edit different sections of the same file while offline. " +
        "After syncing, the merged file should contain both edits.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "header\nmiddle\nfooter"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "header by 0\nmiddle\nfooter"
        },
        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "header\nmiddle\nfooter by 1"
        },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "assert-consistent", verify: (state) => state.assertFileCount(1).assertContent("doc.md", "header by 0\nmiddle\nfooter by 1") }
    ]
};
