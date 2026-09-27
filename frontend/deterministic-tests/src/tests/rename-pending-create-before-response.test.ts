import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renamePendingCreateBeforeResponseTest: TestDefinition = {
    description:
        "Client 0 creates a file while its create request is held, then renames it before the create completes. After releasing the request, both clients should converge with the file at the renamed path.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        { type: "hold-request", client: 0, kind: "create", point: "before" },

        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "original-content"
        },
        { type: "wait-for-request", client: 0 },

        {
            type: "rename",
            client: 0,
            oldPath: "doc.md",
            newPath: "renamed.md"
        },

        { type: "release-request", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent(
                    "renamed.md",
                    "original-content"
                );
            }
        }
    ]
};
