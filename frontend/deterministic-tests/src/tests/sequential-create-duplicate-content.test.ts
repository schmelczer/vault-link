import type { TestDefinition } from "../test-definition";

export const sequentialCreateDuplicateContentTest: TestDefinition = {
    description:
        "Client 0 creates A.md, syncs, then creates B.md with identical content. Both files must remain as separate documents on both clients.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "identical content here" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) => s.assertContent("A.md", "identical content here"),
        },

        { type: "create", client: 0, path: "B.md", content: "identical content here" },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s
                    .assertFileCount(2)
                    .assertContent("A.md", "identical content here")
                    .assertContent("B.md", "identical content here"),
        }
    ]
};
