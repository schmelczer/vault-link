import type { TestDefinition } from "../test-definition";

export const textPendingCreateNotDisplacedTest: TestDefinition = {
    description:
        "Two clients each create a text file at the same path while offline. " +
        "After syncing, the file should contain merged content from both clients.",
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

        { type: "assert-consistent", verify: (s) => s.assertFileCount(1).assertFileExists("data.txt").assertAnyFileContains("data from client 0", "data from client 1") }
    ]
};
