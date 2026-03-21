import type { TestDefinition } from "../test-definition";

export const renameCreateConflictTest: TestDefinition = {
    name: "Rename-Create Conflict",
    description:
        "Client 0 creates file A, Client 1 renames A to B, then Client 0 (without syncing) creates B. " +
        "The system must resolve the conflict deterministically.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "create", client: 0, path: "A.md", content: "hi" },
        { type: "sync", client: 0 },
        { type: "sync", client: 1 },
        { type: "assert-exists", client: 1, path: "A.md" },
        { type: "assert-content", client: 1, path: "A.md", content: "hi" },
        { type: "disable-sync", client: 0 },
        { type: "rename", client: 1, oldPath: "A.md", newPath: "B.md" },
        { type: "sync", client: 1 },
        { type: "create", client: 0, path: "B.md", content: "hi" },
        { type: "enable-sync", client: 0 },
        { type: "barrier" },
        { type: "assert-consistent" }
    ]
};
