import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const deleteRecreatedPendingCreateWithStaleDeletingRecordTest: TestDefinition =
    {
        description:
            "A local delete for a recreated pending create must target the " +
            "new pending create, not an older same-path record whose server " +
            "delete has been acked but whose WebSocket delete receipt is " +
            "still paused.",
        clients: 2,
        steps: [
            { type: "enable-sync", client: 0 },
            { type: "enable-sync", client: 1 },
            { type: "barrier" },

            { type: "pause-websocket", client: 0 },
            { type: "pause-server" },
            {
                type: "create",
                client: 0,
                path: "binary-14.bin",
                content: "BINARY:first"
            },
            { type: "sleep", ms: 100 },
            { type: "delete", client: 0, path: "binary-14.bin" },
            { type: "resume-server" },
            { type: "sync", client: 0 },

            { type: "pause-server" },
            {
                type: "create",
                client: 0,
                path: "binary-14.bin",
                content: "BINARY:second"
            },
            { type: "sleep", ms: 100 },
            { type: "delete", client: 0, path: "binary-14.bin" },
            { type: "resume-server" },
            { type: "sync", client: 0 },

            { type: "resume-websocket", client: 0 },
            { type: "barrier" },

            {
                type: "assert-consistent",
                verify: (state: AssertableState): void => {
                    state.assertFileCount(0);
                }
            }
        ]
    };
