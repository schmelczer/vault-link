import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";


function verifyBothFilesExist(state: ClientState): void {
    assert(
        state.files.size === 2,
        `Expected 2 files, got ${state.files.size}: ${[...state.files.keys()].join(", ")}`
    );
    assert(
        state.files.has("data.bin"),
        "Expected data.bin to exist"
    );
    assert(
        state.files.has("data (1).bin"),
        "Expected data (1).bin to exist"
    );

    const contents = new Set(state.files.values());
    assert(
        contents.has("binary data from client 0"),
        `Expected one file to contain "binary data from client 0"`
    );
    assert(
        contents.has("binary data from client 1"),
        `Expected one file to contain "binary data from client 1"`
    );
}

export const binaryPendingCreateNotDisplacedTest: TestDefinition = {
    name: "Binary Pending Create Not Displaced By Remote Create",
    description:
        "When both clients create a binary file at the same path, the " +
        "server deconflicts them into separate documents. Both files " +
        "should exist on both clients after sync.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        // Both go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Both create binary file at same path (use .bin extension)
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

        // Both come online
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        // Both files should exist (server deconflicted them)
        { type: "assert-consistent", verify: verifyBothFilesExist }
    ]
};
