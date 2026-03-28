import type { TestDefinition } from "../test-definition";

export const createUpdateCoalesceServerPauseTest: TestDefinition = {
    description:
        "Client creates a file and immediately updates it while the server is " +
        "paused. When the server resumes, both clients should have the final " +
        "updated content.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        { type: "pause-server" },

        { type: "create", client: 0, path: "doc.md", content: "initial" },
        { type: "update", client: 0, path: "doc.md", content: "final version" },

        { type: "resume-server" },

        { type: "barrier" },

        { type: "assert-consistent", verify: (state) => state.assertFileCount(1).assertContent("doc.md", "final version") }
    ]
};
