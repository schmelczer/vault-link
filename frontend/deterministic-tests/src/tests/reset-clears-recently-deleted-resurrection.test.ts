import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const resetClearsRecentlyDeletedResurrectionTest: TestDefinition = {
    description:
        "Client 0 deletes a file. Client 1 toggles sync off and on " +
        "(simulating reconnect). The deleted file should NOT reappear " +
        "on Client 1 after the sync reset.",
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

        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 1 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(0);
            }
        }
    ]
};
