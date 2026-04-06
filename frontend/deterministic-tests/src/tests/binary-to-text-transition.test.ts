import type { TestDefinition } from "../test-definition";

export const binaryToTextTransitionTest: TestDefinition = {
    description:
        "A .bin file is created and synced. Both clients edit it offline " +
        "(binary last-write-wins), then client 0 renames it to .md and " +
        "writes a clean text baseline. Both clients edit different sections " +
        "offline. The text merge should preserve both edits.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "data.bin", content: "original content" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        { type: "assert-consistent", verify: (s) => s.assertContent("data.bin", "original content") },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "update", client: 0, path: "data.bin", content: "version A" },
        { type: "update", client: 1, path: "data.bin", content: "version B" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(1).assertContainsAny("data.bin", "version A", "version B") },

        { type: "disable-sync", client: 1 },
        { type: "rename", client: 0, oldPath: "data.bin", newPath: "data.md" },
        { type: "update", client: 0, path: "data.md", content: "top line\nmiddle line\nbottom line" },
        { type: "sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        { type: "assert-consistent", verify: (s) => s.assertContent("data.md", "top line\nmiddle line\nbottom line") },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        { type: "update", client: 0, path: "data.md", content: "alpha\nmiddle line\nbottom line" },
        { type: "update", client: 1, path: "data.md", content: "top line\nmiddle line\nbeta" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "assert-consistent", verify: (s) => s.assertFileCount(1).assertContains("data.md", "alpha", "beta") },
    ],
};
