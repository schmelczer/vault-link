import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const idempotencyAfterServerPauseTest: TestDefinition = {
    description:
        "Lose an accepted create response and require an identical retry, preserving one exact copy.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        { type: "drop-response", client: 0, kind: "create", point: "after" },

        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "important data"
        },
        { type: "wait-for-response-drop", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("doc.md", "important data");
            }
        }
    ]
};
