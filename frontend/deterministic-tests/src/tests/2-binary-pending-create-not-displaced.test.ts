import type { TestDefinition } from "../test-definition";
import type { AssertableState } from "../utils/assertable-state";

export const binaryPendingCreateNotDisplacedTest: TestDefinition = {
    name: "Both offline binary creates at same path survive sync",
    description:
        "Two clients each create a binary file at the same path while offline. " +
        "After syncing, both files should exist on both clients at separate paths.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "data.bin",
            content: "binary data from client 0"
        },
        {
            type: "create",
            client: 1,
            path: "data.bin",
            content: "binary data from client 1"
        },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyBothFilesExist }
    ]
};

function verifyBothFilesExist(state: AssertableState): void {
    state
        .assertFileCount(2)
        .assertFileExists("data.bin")
        .assertFileExists("data (1).bin")
        .assertAnyFileContains(
            "binary data from client 0",
            "binary data from client 1"
        );
}
