import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const idempotencyAfterServerPauseTest: TestDefinition = {
    description:
        "Client 0 creates a file, then the server is paused mid-response. " +
        "After the server resumes, both clients must converge to a single copy of the file with no duplicates.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "important data"
        },
        { type: "pause-server" },

        { type: "resume-server" },

        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("doc.md", "important data");
            }
        }
    ]
};
