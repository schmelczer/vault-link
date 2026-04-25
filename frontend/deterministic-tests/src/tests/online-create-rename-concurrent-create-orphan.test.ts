import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const onlineCreateRenameConcurrentCreateOrphanTest: TestDefinition = {
    description:
        "Client 0 creates a binary file and renames it while offline, then reconnects and immediately deletes it. " +
        "Both clients must converge to zero files.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },

        {
            type: "create",
            client: 0,
            path: "data.bin",
            content: "BINARY:offline-content"
        },
        {
            type: "rename",
            client: 0,
            oldPath: "data.bin",
            newPath: "moved.bin"
        },

        { type: "enable-sync", client: 0 },
        { type: "delete", client: 0, path: "moved.bin" },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(0);
            }
        }
    ]
};
