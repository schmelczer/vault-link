import type { TestDefinition } from "../test-definition";
import type { AssertableState } from "../utils/assertable-state";

export const textPendingCreateNotDisplacedTest: TestDefinition = {
    name: "Both offline binary creates at same path survive sync",
    description:
        "Two clients each create a binary file at the same path while offline. " +
        "After syncing, both files should exist on both clients at separate paths.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "data.txt",
            content: "text data from client 0"
        },
        {
            type: "create",
            client: 1,
            path: "data.txt",
            content: "text data from client 1"
        },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyBothFilesExist }
    ]
};

function verifyBothFilesExist(state: AssertableState): void {
    state
        .assertFileCount(1)
        .assertFileExists("data.txt")
        .assertAnyFileContains(
            "data from client 0",
            "data from client 1"
        );
}
