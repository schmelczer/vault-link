import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const rapidCreateUpdateDeleteCycleTest: TestDefinition = {
    description:
        "Client 0 rapidly creates, updates, deletes, then re-creates a file while its create request is held. " +
        "After releasing the request, client 1 must see only the final file.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "hold-request", client: 0, kind: "create", point: "before" },

        {
            type: "create",
            client: 0,
            path: "cycle.md",
            content: "version 1"
        },
        { type: "wait-for-request", client: 0 },
        {
            type: "update",
            client: 0,
            path: "cycle.md",
            content: "version 2"
        },
        { type: "delete", client: 0, path: "cycle.md" },

        { type: "release-request", client: 0 },
        { type: "sync" },

        {
            type: "create",
            client: 0,
            path: "cycle.md",
            content: "final creation"
        },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent(
                    "cycle.md",
                    "final creation"
                );
            }
        }
    ]
};
