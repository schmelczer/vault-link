import type { TestDefinition } from "../test-definition";

export const renameRoundtripTest: TestDefinition = {
    description:
        "Client 0 creates A.md, renames it to B.md, then renames it back to A.md. After each step both clients sync. Both should end with only A.md at the original path.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s) => s.assertContent("A.md", "original"),
        },

        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertFileNotExists("A.md").assertContent("B.md", "original"),
        },

        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertFileNotExists("B.md").assertContent("A.md", "original"),
        }
    ]
};
