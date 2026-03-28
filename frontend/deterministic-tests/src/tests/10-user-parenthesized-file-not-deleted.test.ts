import type { TestDefinition } from "../test-definition";

export const userParenthesizedFileNotDeletedTest: TestDefinition = {
    description:
        "A user-created file named 'Chapter (1).bin' alongside 'Chapter.bin' should not " +
        "be mistakenly removed when another client creates a conflicting file.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },

        {
            type: "create",
            client: 0,
            path: "Chapter.bin",
            content: "chapter one"
        },
        {
            type: "create",
            client: 0,
            path: "Chapter (1).bin",
            content: "chapter one notes"
        },

        { type: "sync", client: 0 },

        {
            type: "create",
            client: 1,
            path: "Chapter.bin",
            content: "chapter one notes"
        },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state) => {
                state
                    .assertFileCount(3)
                    .assertFileExists("Chapter.bin")
                    .assertFileExists("Chapter (1).bin")
                    .assertFileExists("Chapter (2).bin");
            }
        }
    ]
};
