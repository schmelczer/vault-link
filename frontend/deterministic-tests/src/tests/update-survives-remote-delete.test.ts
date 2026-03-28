import type { TestDefinition } from "../test-definition";

export const updateSurvivesRemoteDeleteTest: TestDefinition = {
    description:
        "Client 0 deletes a file while client 1 edits it offline. Client 0 syncs the delete first, then client 1 reconnects. The edited file should survive on both clients.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "delete", client: 0, path: "doc.md" },
        { type: "update", client: 1, path: "doc.md", content: "edited by client 1" },

        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },

        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertFileCount(1).assertContains("doc.md", "edited by client 1"),
        },
    ],
};
