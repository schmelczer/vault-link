import type { TestDefinition } from "../test-definition";

export const binaryToTextTransitionTest: TestDefinition = {
    description:
        "A .bin file is created and synced. Both clients edit it offline, " +
        "then it is renamed to .md. Both clients edit different sections " +
        "offline again. The second merge should preserve both edits.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "data.bin", content: "original content" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        { type: "assert-consistent", verify: (s) => s.assertContent("data.bin", "original content") },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "update", client: 0, path: "data.bin", content: "version A from client 0" },
        { type: "update", client: 1, path: "data.bin", content: "version B from client 1" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(1).assertContainsAny("data.bin", "version A from client 0", "version B from client 1") },

        { type: "disable-sync", client: 1 },
        { type: "rename", client: 0, oldPath: "data.bin", newPath: "data.md" },
        { type: "sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        { type: "assert-consistent", verify: (s) => s.assertFileExists("data.md") },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "update", client: 0, path: "data.md", content: "top edit from 0\nmiddle line\nshared end" },
        { type: "update", client: 1, path: "data.md", content: "shared start\nmiddle line\nbottom edit from 1" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(1).assertContains("data.md", "top edit from 0", "bottom edit from 1") },
    ],
};
