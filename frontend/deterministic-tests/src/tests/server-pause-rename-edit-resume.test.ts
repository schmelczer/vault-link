import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const serverPauseRenameEditResumeTest: TestDefinition = {
    description:
        "Client 0 creates A.md and syncs. Server is paused. Client 0 " +
        "renames A.md to B.md and edits B.md. Server resumes. Both the " +
        "rename and edit should propagate to Client 1.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "original content"
        },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("A.md", "original content");
            }
        },

        { type: "pause-server" },

        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        {
            type: "update",
            client: 0,
            path: "B.md",
            content: "edited after rename during pause"
        },

        { type: "resume-server" },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1)
                    .assertFileNotExists("A.md")
                    .assertContent("B.md", "edited after rename during pause");
            }
        }
    ]
};
