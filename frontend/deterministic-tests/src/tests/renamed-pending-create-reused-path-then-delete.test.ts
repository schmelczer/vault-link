import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renamedPendingCreateReusedPathThenDeleteTest: TestDefinition = {
    description:
        "A queued create is renamed away from file-59.md, a newer local " +
        "file reuses file-59.md before the queued create drains, and the " +
        "renamed-away generation is deleted. The delete must not erase or " +
        "orphan the newer file-59.md generation.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "hold-request", client: 1, kind: "create", point: "before" },
        {
            type: "create",
            client: 1,
            path: "blocker.md",
            content: "blocker\n"
        },
        { type: "wait-for-request", client: 1 },

        {
            type: "create",
            client: 1,
            path: "file-59.md",
            content: "old\n"
        },
        {
            type: "rename",
            client: 1,
            oldPath: "file-59.md",
            newPath: "file-33.md"
        },
        {
            type: "create",
            client: 1,
            path: "file-59.md",
            content: "new\n"
        },

        { type: "delete", client: 1, path: "file-33.md" },
        { type: "release-request", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertFileCount(2)
                    .assertContent("blocker.md", "blocker\n")
                    .assertContent("file-59.md", "new\n")
                    .assertFileNotExists("file-33.md");
            }
        }
    ]
};
