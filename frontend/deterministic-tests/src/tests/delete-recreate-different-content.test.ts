import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const deleteRecreateDifferentContentTest: TestDefinition = {
    description:
        "Client 0 deletes and recreates A.md with new content offline while client 1 edits A.md offline. " +
        "Both clients should converge with content from both sides merged.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "original content here"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "delete", client: 0, path: "A.md" },
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "brand new content"
        },

        {
            type: "update",
            client: 1,
            path: "A.md",
            content: "edit from client 1"
        },

        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContains(
                    "A.md",
                    "brand new",
                    "client 1"
                );
            }
        }
    ]
};
