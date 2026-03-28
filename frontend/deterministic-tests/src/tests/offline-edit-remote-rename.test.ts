import type { TestDefinition } from "../test-definition";

export const offlineEditRemoteRenameTest: TestDefinition = {
    description:
        "Client 0 edits A.md offline while client 1 renames A.md to B.md. " +
        "After client 0 reconnects, the edit must appear in B.md and A.md must not exist.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s) => s.assertContent("A.md", "original")
        },

        { type: "disable-sync", client: 0 },
        {
            type: "update",
            client: 0,
            path: "A.md",
            content: "edited by client 0"
        },

        {
            type: "rename",
            client: 1,
            oldPath: "A.md",
            newPath: "B.md"
        },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s
                    .assertFileNotExists("A.md")
                    .assertFileCount(1)
                    .assertContains("B.md", "edited by client 0")
        }
    ]
};
