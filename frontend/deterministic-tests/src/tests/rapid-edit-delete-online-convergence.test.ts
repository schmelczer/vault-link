import type { TestDefinition } from "../test-definition";

export const rapidEditDeleteOnlineConvergenceTest: TestDefinition = {
    description:
        "Client 0 rapidly edits multiple files while client 1 deletes some of them, all while both are online. " +
        "Both clients must converge to a consistent state.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content A" },
        { type: "create", client: 0, path: "B.md", content: "content B" },
        { type: "create", client: 0, path: "C.md", content: "content C" },
        { type: "create", client: 0, path: "D.md", content: "content D" },
        { type: "create", client: 0, path: "E.md", content: "content E" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "update", client: 0, path: "A.md", content: "A edit 1" },
        { type: "update", client: 0, path: "B.md", content: "B edit 1" },
        { type: "update", client: 0, path: "C.md", content: "C edit 1" },
        { type: "delete", client: 1, path: "A.md" },
        { type: "delete", client: 1, path: "C.md" },
        { type: "delete", client: 1, path: "E.md" },
        { type: "update", client: 0, path: "A.md", content: "A edit 2" },
        { type: "update", client: 0, path: "B.md", content: "B edit 2" },
        { type: "update", client: 0, path: "C.md", content: "C edit 2" },

        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s) => {
                for (const [path, content] of s.files) {
                    for (const clientFiles of s.clientFiles) {
                        if (clientFiles.has(path) && clientFiles.get(path) !== content) {
                            throw new Error(
                                `Content mismatch for ${path}: "${clientFiles.get(path)}" vs "${content}"`
                            );
                        }
                    }
                }
            },
        },
    ],
};
