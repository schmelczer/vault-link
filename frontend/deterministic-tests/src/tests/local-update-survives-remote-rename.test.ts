import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const localUpdateSurvivesRemoteRenameTest: TestDefinition = {
    description:
        "Hold the event response carrying a remote rename, edit the old local path, then release catchup. Preserve the exact user edit at the renamed path.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "v1\n" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "hold-request", client: 0, kind: "events", point: "after" },

        {
            type: "rename",
            client: 1,
            oldPath: "doc.md",
            newPath: "renamed.md"
        },
        { type: "sync", client: 1 },
        { type: "wait-for-request", client: 0 },

        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "v1\nclient 0 edit\n"
        },

        { type: "release-request", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(1);
                state.assertFileExists("renamed.md");
                state.assertContent("renamed.md", "v1\nclient 0 edit\n");
            }
        }
    ]
};
