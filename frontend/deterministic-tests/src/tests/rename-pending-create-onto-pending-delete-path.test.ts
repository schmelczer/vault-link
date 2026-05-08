import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renamePendingCreateOntoPendingDeletePathTest: TestDefinition = {
    description:
        "A pending create is renamed onto a path whose old server document " +
        "has a queued delete. The delete must reach the server before the " +
        "new create so the new generation is not merged into the soon-to-be " +
        "deleted document.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "create",
            client: 1,
            path: "file-17.md",
            content: "old\n"
        },
        { type: "barrier" },

        { type: "pause-server" },
        {
            type: "create",
            client: 1,
            path: "blocker.md",
            content: "blocker\n"
        },
        { type: "sleep", ms: 100 },
        {
            type: "create",
            client: 1,
            path: "file-23.md",
            content: "new\n"
        },
        { type: "delete", client: 1, path: "file-17.md" },
        {
            type: "rename",
            client: 1,
            oldPath: "file-23.md",
            newPath: "file-17.md"
        },
        { type: "resume-server" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertFileCount(2)
                    .assertContent("blocker.md", "blocker\n")
                    .assertContent("file-17.md", "new\n")
                    .assertFileNotExists("file-23.md");
            }
        }
    ]
};
