import type { TestDefinition } from "../test-definition";

export const moveIdenticalContentAmbiguityTest: TestDefinition = {
    name: "Move Detection Ambiguity With Identical Content",
    description:
        "Two files with identical content exist. One is deleted and the other renamed " +
        "while offline. The system should still converge correctly despite the ambiguity.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "identical content"
        },
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "identical content"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-content",
            client: 1,
            path: "A.md",
            content: "identical content"
        },
        {
            type: "assert-content",
            client: 1,
            path: "B.md",
            content: "identical content"
        },

        { type: "disable-sync", client: 1 },
        { type: "delete", client: 1, path: "A.md" },
        { type: "rename", client: 1, oldPath: "B.md", newPath: "C.md" },

        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state) => {
                state
                    .assertFileCount(1)
                    .assertFileNotExists("A.md")
                    .assertFileNotExists("B.md")
                    .assertContent("C.md", "identical content");
            }
        }
    ]
};
