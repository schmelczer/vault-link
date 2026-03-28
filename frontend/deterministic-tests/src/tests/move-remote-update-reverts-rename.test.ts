import type { TestDefinition } from "../test-definition";

export const moveRemoteUpdateRevertsRenameTest: TestDefinition = {
    description:
        "Client 1 updates a file while client 0 is offline. Client 0 reconnects and renames the file. " +
        "Both clients should converge with client 1's updated content.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "update", client: 1, path: "doc.md", content: "updated by client 1" },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "doc.md", newPath: "renamed.md" },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s) => {
                s.assertFileCount(1);
                const content = Array.from(s.files.values())[0];
                if (content !== "updated by client 1") {
                    throw new Error(`Expected "updated by client 1", got: "${content}"`);
                }
            }
        }
    ]
};
