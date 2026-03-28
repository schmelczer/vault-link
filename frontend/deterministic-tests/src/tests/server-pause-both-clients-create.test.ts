import type { TestDefinition } from "../test-definition";

export const serverPauseBothClientsCreateTest: TestDefinition = {
    description:
        "Client 0 creates a file, then the server is paused. Client 1 creates a different file while the server is paused. After the server resumes, both files should exist on both clients.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "create",
            client: 0,
            path: "alpha.md",
            content: "from client 0"
        },
        { type: "pause-server" },

        {
            type: "create",
            client: 1,
            path: "beta.md",
            content: "from client 1"
        },

        { type: "resume-server" },

        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s
                    .assertContains("alpha.md", "from client 0")
                    .assertContains("beta.md", "from client 1"),
        }
    ]
};
