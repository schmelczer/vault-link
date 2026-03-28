import type { TestDefinition } from "../test-definition";

export const concurrentRenameFirstWinsTest: TestDefinition = {
    description:
        "Both clients start online with the same file. Both go offline, " +
        "rename the file to different paths, and edit it. When they reconnect, " +
        "the first rename to reach the server wins the path and both content " +
        "edits are merged.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "line 1\nline 2\nline 3" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        { type: "assert-consistent", verify: (s) => s.assertContent("A.md", "line 1\nline 2\nline 3") },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "update", client: 0, path: "B.md", content: "edit from 0\nline 2\nline 3" },

        { type: "rename", client: 1, oldPath: "A.md", newPath: "C.md" },
        { type: "update", client: 1, path: "C.md", content: "line 1\nline 2\nedit from 1" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => {
            s.assertFileNotExists("A.md");
            s.assertFileCount(1);
            s.assertAnyFileContains("edit from 0", "edit from 1");
        } },
    ],
};
