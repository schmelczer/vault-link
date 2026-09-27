import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const updateDuringCreateProcessingTest: TestDefinition = {
    description:
        "Client 0 creates a file while its create request is held, then immediately updates it. After releasing the request, both clients should converge with the updated content.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "hold-request", client: 0, kind: "create", point: "before" },

        {
            type: "create",
            client: 0,
            path: "file.md",
            content: "initial"
        },
        { type: "wait-for-request", client: 0 },

        {
            type: "update",
            client: 0,
            path: "file.md",
            content: "updated during create"
        },

        { type: "release-request", client: 0 },
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
