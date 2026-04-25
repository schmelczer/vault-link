import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineDeleteRemoteRenameTest: TestDefinition = {
    description:
        "Client 0 deletes A.md offline while client 1 renames it to A_renamed.md. " +
        "After client 0 reconnects, both clients must converge.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "delete", client: 0, path: "A.md" },

        {
            type: "rename",
            client: 1,
            oldPath: "A.md",
            newPath: "A_renamed.md"
        },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileNotExists("A.md").assertFileNotExists(
                    "A_renamed.md"
                );
            }
        }
    ]
};
