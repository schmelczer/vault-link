import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const binaryPendingCreateNotDisplacedTest: TestDefinition = {
    description:
        "Two clients each create a binary file at the same path while offline. " +
        "After syncing, both files should exist on both clients at separate paths.",
    clients: 2,
    steps: [
        // Bootstrap both empty clients before making independent documents.
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
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

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(2)
                    .assertFileExists("data.bin")
                    .assertFileExists(s.conflictPath("data.bin"))
                    .assertAnyFileContains(
                        "binary data from client 0",
                        "binary data from client 1"
                    );
            }
        }
    ]
};
