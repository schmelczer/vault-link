import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const watermarkAdvancesOnSkipTest: TestDefinition = {
    description:
        "Both clients create the same file offline. After syncing, both disconnect and reconnect. The reconnect should not replay already-processed updates.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "create", client: 0, path: "doc.md", content: "from client 0" },
        { type: "create", client: 1, path: "doc.md", content: "from client 1" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertFileExists("doc.md");
            }
        }
    ]
};
