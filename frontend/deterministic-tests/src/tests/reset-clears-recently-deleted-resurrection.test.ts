import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const resetClearsRecentlyDeletedResurrectionTest: TestDefinition = {
    description:
        "Client 0 deletes a file. Client 1 calls `reset` (clears tracked " +
        "state — recently-deleted set, watermark, doc records — but keeps " +
        "disk files). After the reset and re-handshake, the deleted file " +
        "should NOT reappear via offline-scan resurrection. This is the " +
        "stronger probe than disable/enable-sync, which keeps the " +
        "recently-deleted suppression set intact.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "ghost.md",
            content: "should be deleted"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "delete", client: 0, path: "ghost.md" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileNotExists("ghost.md");
            }
        },

        { type: "reset", client: 1 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(0);
            }
        }
    ]
};
