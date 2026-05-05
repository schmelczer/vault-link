import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const queuedCreateDeleteDoesNotHijackReusedPathTest: TestDefinition = {
    description:
        "A create/delete pair that is still queued behind another request " +
        "must collapse locally. It must not later read a different file " +
        "that reused the same path before the queued create drained.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "pause-server" },
        {
            type: "create",
            client: 1,
            path: "blocker.bin",
            content: "BINARY:blocker"
        },
        { type: "sleep", ms: 100 },
        {
            type: "create",
            client: 1,
            path: "target.bin",
            content: "BINARY:old"
        },
        { type: "delete", client: 1, path: "target.bin" },
        {
            type: "create",
            client: 1,
            path: "source.bin",
            content: "BINARY:new"
        },
        {
            type: "rename",
            client: 1,
            oldPath: "source.bin",
            newPath: "target.bin"
        },
        { type: "resume-server" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertFileCount(2)
                    .assertContent("blocker.bin", "BINARY:blocker")
                    .assertContent("target.bin", "BINARY:new")
                    .assertFileNotExists("source.bin");
            }
        }
    ]
};
