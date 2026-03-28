import type { TestDefinition } from "../test-definition";

export const renameChainTest: TestDefinition = {
    description:
        "Client 0 (offline) creates A.md, renames to B.md, then renames to C.md. " +
        "When sync is enabled, only C.md should exist. Client 1 should receive C.md " +
        "with the original content. Intermediate paths should never appear.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 1 },

        { type: "create", client: 0, path: "A.md", content: "important content" },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "rename", client: 0, oldPath: "B.md", newPath: "C.md" },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s.assertFileNotExists("A.md")
                    .assertFileNotExists("B.md")
                    .assertContent("C.md", "important content"),
        }
    ]
};
