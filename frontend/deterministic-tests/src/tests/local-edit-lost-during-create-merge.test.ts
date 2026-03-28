import type { TestDefinition } from "../test-definition";

export const localEditLostDuringCreateMergeTest: TestDefinition = {
    description:
        "Client 1 creates doc.md. Client 0 creates the same file offline, then connects with the server paused. " +
        "Client 0 edits the file while the create is stalled. After resume, both clients' content must be merged.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "create", client: 1, path: "doc.md", content: "from-client-1" },
        { type: "sync", client: 1 },

        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "from-client-0"
        },

        { type: "pause-server" },

        { type: "enable-sync", client: 0 },

        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "local-edit-during-create"
        },

        { type: "resume-server" },

        { type: "sync" },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(1).assertContains("doc.md", "from-client-1", "local-edit-during-create") }
    ]
};
