import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineRenameRemoteCreateOldPathTest: TestDefinition = {
    description:
        "Client 0 renames X.md to Y.md while offline. Client 1 updates X.md " +
        "(same document). When Client 0 reconnects, the rename and update " +
        "should merge. Y.md should exist with Client 1's content.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "X.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("X.md", "original");
            }
        },

        { type: "disable-sync", client: 0 },
        {
            type: "rename",
            client: 0,
            oldPath: "X.md",
            newPath: "Y.md"
        },

        {
            type: "update",
            client: 1,
            path: "X.md",
            content: "updated-by-client-1"
        },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContains(
                    "Y.md",
                    "updated-by-client-1"
                );
            }
        }
    ]
};
