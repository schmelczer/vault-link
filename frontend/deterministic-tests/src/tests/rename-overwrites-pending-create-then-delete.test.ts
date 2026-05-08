import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renameOverwritesPendingCreateThenDeleteTest: TestDefinition = {
    description:
        "A pending local create at a path must not mask a synced document renamed onto that path; later rename/delete events still belong to the synced document.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        {
            type: "create",
            client: 0,
            path: "tracked.bin",
            content: "BINARY:tracked"
        },
        { type: "barrier" },

        { type: "pause-server" },

        {
            type: "create",
            client: 0,
            path: "pending.bin",
            content: "BINARY:pending"
        },
        {
            type: "rename",
            client: 0,
            oldPath: "tracked.bin",
            newPath: "pending.bin"
        },
        {
            type: "rename",
            client: 0,
            oldPath: "pending.bin",
            newPath: "final.bin"
        },
        { type: "delete", client: 0, path: "final.bin" },

        { type: "resume-server" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(0);
            }
        }
    ]
};
