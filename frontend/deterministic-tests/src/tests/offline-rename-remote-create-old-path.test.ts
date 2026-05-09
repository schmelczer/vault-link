import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineRenameRemoteCreateOldPathTest: TestDefinition = {
    description:
        "Offline-rename vs. concurrent remote-update of the same doc. " +
        "Client 0 renames X.md to Y.md while offline. Client 1 updates X.md " +
        "(same document) and syncs. When Client 0 reconnects, the rename " +
        "and update must merge: Y.md must hold Client 1's updated content. " +
        "(Filename is legacy — there is no remote create at the old path; " +
        "this is the rename-vs-update mirror of offline-edit-remote-rename.)",
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
                // Pin exact content + path: rename and update must
                // collapse onto Y.md with Client 1's update.
                s.assertFileCount(1).assertContent(
                    "Y.md",
                    "updated-by-client-1"
                );
            }
        }
    ]
};
