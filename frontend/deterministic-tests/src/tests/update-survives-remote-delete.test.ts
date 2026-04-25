import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const updateDoesNotSurvivesRemoteDeleteTest: TestDefinition = {
    description:
        "Client 0 deletes a file while client 1 edits it offline. Client 0 syncs the delete first, then client 1 reconnects. Deletes always win.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "delete", client: 0, path: "doc.md" },
        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "edited by client 1"
        },

        { type: "enable-sync", client: 0 },
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
