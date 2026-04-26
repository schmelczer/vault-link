import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const onlineCreateUpdateWhileOtherCreatesSamePathTest: TestDefinition = {
    description:
        "Client 0 creates a binary file and updates it while client 1 also " +
        "creates a binary file at the same path. Both clients are online. " +
        "Both clients must end up with the same file set.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        { type: "pause-websocket", client: 1 },
        {
            type: "create",
            client: 0,
            path: "data.bin",
            content: "BINARY:content-v1"
        },
        {
            type: "update",
            client: 0,
            path: "data.bin",
            content: "BINARY:content-v2"
        },
        {
            type: "create",
            client: 1,
            path: "data.bin",
            content: "BINARY:other-content"
        },
        { type: "resume-websocket", client: 1 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertFileCount(2)
                    .assertNoFileContains("content-v1")
                    .assertAnyFileContains("content-v2")
                    .assertAnyFileContains("other-content");
            }
        }
    ]
};
