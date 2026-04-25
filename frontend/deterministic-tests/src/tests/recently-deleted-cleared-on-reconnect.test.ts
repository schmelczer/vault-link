import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const recentlyDeletedClearedOnReconnectTest: TestDefinition = {
    description:
        "After a client deletes a document and reconnects, it should " +
        "accept new documents from other clients even if they happen to " +
        "arrive at the same path as the deleted document.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "sync" },

        { type: "delete", client: 0, path: "doc.md" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        {
            type: "create",
            client: 1,
            path: "doc.md",
            content: "new content from client 1"
        },

        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent(
                    "doc.md",
                    "new content from client 1"
                );
            }
        }
    ]
};
