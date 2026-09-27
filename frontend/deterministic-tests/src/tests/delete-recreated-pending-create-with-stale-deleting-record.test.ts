import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const deleteRecreatedPendingCreateWithStaleDeletingRecordTest: TestDefinition =
    {
        description:
            "Delete two successive generations while each create request is " +
            "held before send. Retrying and acknowledging the old generation " +
            "must not resurrect either file, even with delayed WebSocket hints.",
        clients: 2,
        steps: [
            { type: "enable-sync", client: 0 },
            { type: "enable-sync", client: 1 },
            { type: "barrier" },

            { type: "pause-websocket", client: 0 },
            {
                type: "hold-request",
                client: 0,
                kind: "create",
                point: "before"
            },
            {
                type: "create",
                client: 0,
                path: "binary-14.bin",
                content: "BINARY:first"
            },
            { type: "wait-for-request", client: 0 },
            { type: "delete", client: 0, path: "binary-14.bin" },
            { type: "release-request", client: 0 },
            { type: "sync", client: 0 },

            {
                type: "hold-request",
                client: 0,
                kind: "create",
                point: "before"
            },
            {
                type: "create",
                client: 0,
                path: "binary-14.bin",
                content: "BINARY:second"
            },
            { type: "wait-for-request", client: 0 },
            { type: "delete", client: 0, path: "binary-14.bin" },
            { type: "release-request", client: 0 },
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
