import type { TestDefinition } from "../test-definition";

export const queueResetLosesCoalescedLocalEditTest: TestDefinition = {
    description:
        "Client 1 edits a shared file, then client 0 also edits it and immediately disconnects. " +
        "After client 0 reconnects, both edits must be preserved.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "update", client: 1, path: "doc.md", content: "from client 1" },
        { type: "sync", client: 1 },

        { type: "update", client: 0, path: "doc.md", content: "from client 0" },

        { type: "disable-sync", client: 0 },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertFileCount(1).assertContains("doc.md", "from client 0", "from client 1"),
        }
    ]
};
