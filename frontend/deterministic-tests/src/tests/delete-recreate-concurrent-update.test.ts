import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const deleteRecreateConcurrentUpdateTest: TestDefinition = {
    description:
        "Client 0 deletes and recreates A.md with new content while offline. Client 1 updates A.md concurrently. " +
        "After client 0 reconnects, both clients must converge with client 0's recreated content preserved.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "delete", client: 0, path: "A.md" },
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "recreated by client 0"
        },

        {
            type: "update",
            client: 1,
            path: "A.md",
            content: "updated by client 1"
        },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileExists("A.md").assertContains("A.md", "recreated");
            }
        }
    ]
};
