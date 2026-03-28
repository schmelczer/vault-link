import type { TestDefinition } from "../test-definition";

export const serverPauseBothEditSameFileTest: TestDefinition = {
    description:
        "Both clients edit different sections of the same file while the server is paused. After resuming and converging, client 0 makes another edit to verify further updates still work correctly.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "shared.md",
            content: "line 1: original\nline 2: original\nline 3: original"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "pause-server" },

        {
            type: "update",
            client: 0,
            path: "shared.md",
            content:
                "line 1: edited by client 0\nline 2: original\nline 3: original"
        },
        {
            type: "update",
            client: 1,
            path: "shared.md",
            content:
                "line 1: original\nline 2: original\nline 3: edited by client 1"
        },

        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s
                    .assertFileCount(1)
                    .assertContains("shared.md", "edited by client 0", "edited by client 1"),
        },

        {
            type: "update",
            client: 0,
            path: "shared.md",
            content: "post-merge edit from client 0"
        },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertFileCount(1).assertContains("shared.md", "post-merge edit from client 0"),
        }
    ]
};
