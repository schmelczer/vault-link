import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const moveRemoteUpdateRevertsRenameTest: TestDefinition = {
    description:
        "Client 1 updates a file while client 0 is offline. Client 0 reconnects and renames the file. " +
        "Both clients should converge with client 1's updated content.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "updated by client 1"
        },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "doc.md", newPath: "renamed.md" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent(
                    "renamed.md",
                    "updated by client 1"
                );
            }
        }
    ]
};
