import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const deleteDuringPendingCreateTest: TestDefinition = {
    description:
        "Client 0 creates a file while its create request is held, then deletes it before releasing the request. " +
        "After release, the file should end up deleted on both clients.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "hold-request", client: 0, kind: "create", point: "before" },

        {
            type: "create",
            client: 0,
            path: "ephemeral.md",
            content: "this will be deleted"
        },
        { type: "wait-for-request", client: 0 },

        { type: "delete", client: 0, path: "ephemeral.md" },

        { type: "release-request", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(0).assertFileNotExists("ephemeral.md");
            }
        }
    ]
};
