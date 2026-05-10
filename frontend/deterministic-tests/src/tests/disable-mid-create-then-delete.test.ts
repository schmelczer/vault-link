import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const disableMidCreateThenDeleteTest: TestDefinition = {
    description:
        "Reproduces a fuzz failure where one client's create-then-delete-then-disable-sync " +
        "sequence loses the file: the create commits server-side, the response is " +
        "lost (sync reset), the local file is deleted, then sync is re-enabled. The " +
        "catch-up replay should redeliver the create so both clients converge to " +
        "having the file (the delete never reached the server because its docId " +
        "Promise was rejected when the queue cleared).",
    clients: 2,
    steps: [
        // Client 0 is online (the witness); client 1 starts disabled.
        { type: "enable-sync", client: 0 },

        // Client 1 creates the file while offline so the LocalCreate is queued.
        { type: "create", client: 1, path: "file-32.md", content: "hello" },

        // Arm the drop so client 1's create POST commits server-side but the
        // response is replaced with SyncResetError (matches the fuzz scenario
        // where sync was disabled mid-flight).
        { type: "drop-next-create-response", client: 1 },

        // Enable sync on client 1: offline scan picks up file-32, drain fires
        // POST /documents, server commits, broadcast goes out, response is
        // dropped on the client. SyncResetError exits the drain leaving the
        // create event still in the queue.
        { type: "enable-sync", client: 1 },
        { type: "wait-for-dropped-create-response", client: 1 },

        // The user then deletes the file locally and toggles sync off/on
        // (the same flow the fuzz harness used). The disable's pause()
        // does not clear the queue, but the re-enable runs an offline
        // scan that calls clearPending() — wiping the dangling LocalCreate
        // and any LocalDelete behind it. The local disk is empty, so
        // nothing is enqueued.
        { type: "delete", client: 1, path: "file-32.md" },
        { type: "disable-sync", client: 1 },
        { type: "enable-sync", client: 1 },

        // Catch-up on the new WS connection should deliver file-32 (vault
        // update id 1) since client 1's lastSeenUpdateId is still 0.
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileExists("file-32.md").assertContent(
                    "file-32.md",
                    "hello"
                );
            }
        }
    ]
};
