import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const movePreservesRemoteUpdateTest: TestDefinition = {
    description:
        "Client 0 renames a file offline while client 1 edits it offline. " +
        "After both reconnect, the renamed file should contain client 1's edit.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "line 1\nline 2"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "rename", client: 0, oldPath: "doc.md", newPath: "renamed.md" },
        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "line 1\nclient 1 edit\nline 2"
        },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1);
                const [content] = Array.from(s.files.values());
                if (!content.includes("client 1 edit")) {
                    throw new Error(
                        `Expected merged content to include "client 1 edit", got: "${content}"`
                    );
                }
            }
        }
    ]
};
