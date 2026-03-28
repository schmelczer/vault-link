import type { TestDefinition } from "../test-definition";

export const createDeleteNoopTest: TestDefinition = {
    description:
        "A client creates a file, updates it multiple times, then deletes it, all while " +
        "offline. After syncing, neither client should have the file.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 1 },

        { type: "create", client: 0, path: "temp.md", content: "version 1" },
        { type: "update", client: 0, path: "temp.md", content: "version 2" },
        { type: "update", client: 0, path: "temp.md", content: "version 3" },
        { type: "delete", client: 0, path: "temp.md" },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileNotExists("temp.md") }
    ]
};
