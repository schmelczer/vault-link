import type { TestDefinition } from "../test-definition";

export const createMergeDeleteTest: TestDefinition = {
    description:
        "Two clients create A.md offline with different content. Both come online and " +
        "the content is merged. Then one client deletes A.md. Both clients should " +
        "converge on an empty state.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "from-zero" },
        { type: "create", client: 1, path: "A.md", content: "from-one" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state) => state.assertFileCount(1).assertContains("A.md", "from-zero", "from-one")
        },

        { type: "delete", client: 0, path: "A.md" },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(0).assertFileNotExists("A.md") }
    ]
};
