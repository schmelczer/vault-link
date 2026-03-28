import type { TestDefinition } from "../test-definition";

export const createRenameResponseSkipsFileTest: TestDefinition = {
    description:
        "Client 0 creates a file online then immediately renames it. " +
        "Client 1 must receive the file content at the renamed path.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "the-content"
        },

        {
            type: "rename",
            client: 0,
            oldPath: "doc.md",
            newPath: "renamed.md"
        },

        { type: "sync" },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(1).assertAnyFileContains("the-content") }
    ]
};
