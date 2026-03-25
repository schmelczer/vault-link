import type { TestDefinition } from "../test-definition";

export const updateThenRenameTest: TestDefinition = {
    name: "Update Then Rename While Online",
    description:
        "Client 0 updates A.md then immediately renames it to B.md while online. " +
        "Both the content change and rename should propagate to Client 1.",
    clients: 2,
    steps: [
        // Setup
        { type: "create", client: 0, path: "A.md", content: "v1" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "A.md", content: "v1" },

        // Update then rename (both while online)
        { type: "update", client: 0, path: "A.md", content: "v2-updated" },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "sync" },
        { type: "barrier" },

        // A.md gone, B.md has updated content
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-exists", client: 0, path: "B.md" },
        { type: "assert-exists", client: 1, path: "B.md" },
        { type: "assert-content", client: 0, path: "B.md", content: "v2-updated" },
        { type: "assert-content", client: 1, path: "B.md", content: "v2-updated" },
        { type: "assert-consistent" }
    ]
};
