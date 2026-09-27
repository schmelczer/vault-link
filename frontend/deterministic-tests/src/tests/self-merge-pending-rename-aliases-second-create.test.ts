import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const selfMergePendingRenameAliasesSecondCreateTest: TestDefinition = {
    description:
        "Hold the first create before sending it, then create a second file " +
        "and move both generations through primary.md. Releasing the request " +
        "must preserve distinct documents at moved.md and primary.md, with " +
        "each generation's exact content and the unrelated remote file intact.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "pause-websocket", client: 0 },

        {
            type: "create",
            client: 1,
            path: "filler.md",
            content: "filler-content "
        },
        { type: "sync", client: 1 },

        { type: "hold-request", client: 0, kind: "create", point: "before" },

        {
            type: "create",
            client: 0,
            path: "primary.md",
            content: "primary content "
        },

        { type: "wait-for-request", client: 0 },

        {
            type: "create",
            client: 0,
            path: "staging.md",
            content: "secondary content "
        },

        {
            type: "rename",
            client: 0,
            oldPath: "primary.md",
            newPath: "moved.md"
        },

        {
            type: "rename",
            client: 0,
            oldPath: "staging.md",
            newPath: "primary.md"
        },

        { type: "release-request", client: 0 },
        { type: "resume-websocket", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(3);
                state.assertContent("filler.md", "filler-content ");
                state.assertFileExists("moved.md");
                state.assertFileExists("primary.md");

                state.assertContent("moved.md", "primary content ");
                state.assertContent("primary.md", "secondary content ");

                state.assertContentInAtMostOneFile("primary content");
                state.assertContentInAtMostOneFile("secondary content");
            }
        }
    ]
};
