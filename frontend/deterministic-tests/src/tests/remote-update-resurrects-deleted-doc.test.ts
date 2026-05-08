import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const remoteUpdateResurrectsDeletedDocTest: TestDefinition = {
    description:
        "Client 1 updates, deletes, and recreates P (with a new docId D2). " +
        "While the buffered remote events are being processed by client 0, " +
        "client 0 also makes a local edit to P. The local edit lands in the " +
        "queue while v17 is mid-process, sending v17 down processRemoteUpdate's " +
        "re-enqueue branch. The deferred v17 must NOT later resurrect D1 as a " +
        "conflict-… file at P after the delete and the D2 create have drained.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        { type: "create", client: 1, path: "P.md", content: "v8 content\n" },
        { type: "barrier" },

        { type: "pause-websocket", client: 0 },

        {
            type: "update",
            client: 1,
            path: "P.md",
            content: "v17 content from client 1\n"
        },
        { type: "sync", client: 1 },
        { type: "delete", client: 1, path: "P.md" },
        { type: "sync", client: 1 },
        {
            type: "create",
            client: 1,
            path: "P.md",
            content: "v21 content (D2)\n"
        },
        { type: "sync", client: 1 },

        { type: "resume-websocket", client: 0 },

        {
            type: "update",
            client: 0,
            path: "P.md",
            content: "local edit by client 0\n"
        },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertFileCount(1)
                    .assertContent("P.md", "v21 content (D2)\n");
            }
        }
    ]
};
