import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const remoteQuickWriteRenameBeforeRecordTest: TestDefinition = {
    description:
        "Client 0 receives a remote create and the user renames the new " +
        "file immediately after the syncer writes it. The watcher event " +
        "must bind to the new document instead of being dropped before " +
        "the remote-create handler persists the record.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        {
            type: "rename-next-write",
            client: 0,
            oldPath: "doc.md",
            newPath: "renamed.md"
        },

        { type: "create", client: 1, path: "doc.md", content: "v1\n" },
        { type: "sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1);
                s.assertFileExists("renamed.md");
                s.assertFileNotExists("doc.md");
                s.assertContent("renamed.md", "v1\n");
            }
        }
    ]
};
