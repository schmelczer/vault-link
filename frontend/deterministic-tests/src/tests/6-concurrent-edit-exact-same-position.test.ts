import type { TestDefinition } from "../test-definition";

export const concurrentEditExactSamePositionTest: TestDefinition = {
    name: "Concurrent edits to the exact same word are both preserved",
    description:
        "Both clients replace the same word in a file with different text " +
        "while offline. After syncing, the merged result should contain " +
        "both replacements.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "the quick brown fox"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "doc.md",
            content: "the quick brown fox"
        },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "the slow brown fox"
        },
        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "the fast brown fox"
        },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state) => {
                state
                    .assertFileCount(1)
                    .assertContains("doc.md", "slow", "fast", "brown fox");
            }
        }
    ]
};
