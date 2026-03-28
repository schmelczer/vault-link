import type { TestDefinition } from "../test-definition";

export const deleteRenameConflictTest: TestDefinition = {
    description:
        "Client 0 deletes A.md while client 1 renames A.md to C.md offline. " +
        "After client 1 reconnects, both clients should converge to the same state.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-consistent", verify: (s) => s.assertFileExists("A.md").assertFileExists("B.md") },

        { type: "disable-sync", client: 1 },

        { type: "delete", client: 0, path: "A.md" },
        { type: "sync", client: 0 },

        { type: "rename", client: 1, oldPath: "A.md", newPath: "C.md" },

        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => {
            s.assertContent("B.md", "content-b");
            s.assertFileNotExists("A.md");
            s.ifFileExists("C.md", (s) => s.assertContent("C.md", "content-a"));
        } },
    ]
};
