import type { TestDefinition } from "../test-definition";

export const renamePendingCreateBeforeResponseTest: TestDefinition = {
    description:
        "Client 0 creates a file while the server is paused, then renames it before the create completes. After the server resumes, both clients should converge with the file at the renamed path.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "pause-server" },

        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "original-content"
        },

        {
            type: "rename",
            client: 0,
            oldPath: "doc.md",
            newPath: "renamed.md"
        },

        { type: "resume-server" },

        { type: "sync" },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertFileCount(1).assertContent("renamed.md", "original-content"),
        }
    ]
};
