import type { TestDefinition } from "../test-definition";

export const serverPauseDeleteRecreateTest: TestDefinition = {
    description:
        "Client 1 deletes a file and syncs. The server is paused, then client 0 creates at the same path. After the server resumes, both clients should have the recreated file.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "delete", client: 1, path: "A.md" },
        { type: "barrier" },

        { type: "pause-server" },

        { type: "create", client: 0, path: "A.md", content: "recreated during contention" },

        { type: "resume-server" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state) => {
                state
                    .assertFileCount(1)
                    .assertContent("A.md", "recreated during contention");
            }
        },
    ],
};
