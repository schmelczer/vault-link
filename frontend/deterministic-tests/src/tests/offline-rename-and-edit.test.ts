import type { TestDefinition } from "../test-definition";

export const offlineRenameAndEditTest: TestDefinition = {
    description:
        "Client 0 creates A.md and syncs. Client 0 goes offline, renames A.md " +
        "to B.md, then edits B.md. When Client 0 reconnects, the rename and edit " +
        "should both propagate to Client 1.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s) => s.assertContent("A.md", "original")
        },

        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "update", client: 0, path: "B.md", content: "edited after rename" },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) =>
                s
                    .assertFileNotExists("A.md")
                    .assertFileCount(1)
                    .assertContent("B.md", "edited after rename")
        }
    ]
};
