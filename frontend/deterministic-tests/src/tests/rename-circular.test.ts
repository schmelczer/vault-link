import type { TestDefinition } from "../test-definition";

export const renameCircularTest: TestDefinition = {
    description:
        "Client 0 creates three files, syncs, then goes offline and performs a circular rename via a temp file (A->temp, C->A, B->C, temp->B). After reconnecting, both clients should have rotated content with no temp file remaining.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "create", client: 0, path: "C.md", content: "content-c" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertContent("A.md", "content-a")
                    .assertContent("B.md", "content-b")
                    .assertContent("C.md", "content-c"),
        },

        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "temp-a.md" },
        { type: "rename", client: 0, oldPath: "C.md", newPath: "A.md" },
        { type: "rename", client: 0, oldPath: "B.md", newPath: "C.md" },
        { type: "rename", client: 0, oldPath: "temp-a.md", newPath: "B.md" },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertFileNotExists("temp-a.md")
                    .assertFileCount(3)
                    .assertContent("A.md", "content-c")
                    .assertContent("B.md", "content-a")
                    .assertContent("C.md", "content-b"),
        }
    ]
};
