import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const migrateKeyPreservesExistingTest: TestDefinition = {
    description:
        "Client 0 creates a file and immediately updates it while the server is paused. " +
        "After resume, the update must not be lost.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "pause-server" },

        { type: "create", client: 0, path: "A.md", content: "initial" },
        {
            type: "update",
            client: 0,
            path: "A.md",
            content: "updated by client 0"
        },

        { type: "resume-server" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContains(
                    "A.md",
                    "updated by client 0"
                );
            }
        }
    ]
};
