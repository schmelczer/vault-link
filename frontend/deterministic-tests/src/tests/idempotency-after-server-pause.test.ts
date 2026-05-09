import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const idempotencyAfterServerPauseTest: TestDefinition = {
    description:
        "The server commits Client 0's create but Client 0 never sees the " +
        "response — simulating a connection drop after server-side commit. " +
        "drop-next-create-response intercepts the response in the client's " +
        "fetch wrapper after the server has already processed the POST, " +
        "raising SyncResetError. The client's offline-scan retry must be " +
        "idempotent: server-side dedup of the retried create + the " +
        "already-committed doc must NOT produce a duplicate file. " +
        "(Earlier version did `create -> pause -> resume`, where the " +
        "create could complete cleanly before the pause and the " +
        "idempotency path was never exercised.)",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        // Arm the interceptor BEFORE the create so the very first POST
        // /documents from c0 has its response dropped after server commit.
        { type: "drop-next-create-response", client: 0 },

        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "important data"
        },

        // Block until the server has committed and the client has been
        // notified the response was dropped — deterministic happens-before
        // for "server has the doc, client thinks the create failed".
        { type: "wait-for-dropped-create-response", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                // No duplicate doc despite the client's retry: server-side
                // path-collision merge or idempotency must collapse them.
                s.assertFileCount(1).assertContent("doc.md", "important data");
            }
        }
    ]
};
