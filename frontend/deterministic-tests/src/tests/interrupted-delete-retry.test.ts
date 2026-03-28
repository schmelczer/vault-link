import type { TestDefinition } from "../test-definition";

export const interruptedDeleteRetryTest: TestDefinition = {
    description:
        "Client 0 deletes a file, then the server is paused. " +
        "After the server resumes, both clients should have zero files.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "to be deleted" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "delete", client: 0, path: "doc.md" },

        { type: "pause-server" },

        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(0) },
    ],
};
