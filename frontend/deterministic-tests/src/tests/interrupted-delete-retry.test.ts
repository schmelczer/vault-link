import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const interruptedDeleteRetryTest: TestDefinition = {
    description:
        "Lose an accepted deletion manifest response and require an identical retry, with both clients empty.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "to be deleted" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        { type: "drop-response", client: 0, kind: "manifest", point: "after" },

        { type: "delete", client: 0, path: "doc.md" },

        { type: "wait-for-response-drop", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(0);
            }
        }
    ]
};
