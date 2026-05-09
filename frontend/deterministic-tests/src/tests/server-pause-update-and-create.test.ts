import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const serverPauseUpdateAndCreateTest: TestDefinition = {
    description:
        "Client 0 updates a shared file while client 1 creates a new file, both during a server pause. After the server resumes, both operations should complete and propagate to both clients.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        {
            type: "create",
            client: 0,
            path: "shared.md",
            content: "initial content"
        },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("shared.md", "initial content");
            }
        },

        { type: "pause-server" },

        {
            type: "update",
            client: 0,
            path: "shared.md",
            content: "updated during pause"
        },
        {
            type: "create",
            client: 1,
            path: "new-file.md",
            content: "created by client 1"
        },

        { type: "resume-server" },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent(
                    "shared.md",
                    "updated during pause"
                ).assertContent("new-file.md", "created by client 1");
            }
        }
    ]
};
