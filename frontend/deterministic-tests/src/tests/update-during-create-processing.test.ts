import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const updateDuringCreateProcessingTest: TestDefinition = {
    description:
        "Client 0 creates a file while the server is paused, then immediately updates it. After the server resumes, both clients should converge with the updated content.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "pause-server" },

        {
            type: "create",
            client: 0,
            path: "file.md",
            content: "initial"
        },

        {
            type: "update",
            client: 0,
            path: "file.md",
            content: "updated during create"
        },

        { type: "resume-server" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent(
                    "file.md",
                    "updated during create"
                );
            }
        }
    ]
};
