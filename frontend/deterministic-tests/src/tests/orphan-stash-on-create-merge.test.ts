import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const orphanStashOnCreateMergeTest: TestDefinition = {
    description:
        "Client 1 creates file.md (server doc D). Client 0's WebSocket is " +
        "paused, so the broadcast is buffered. The server is paused, then " +
        "the WebSocket released — Client 0 enters " +
        "`processRemoteCreateForNewDocument` and parks on the GET for D's " +
        "content. While parked, Client 0 creates file.md locally. The GET " +
        "returns and the remote create displaces to " +
        "`conflict-<uuid>-file.md` (slot occupied), tracking D there with " +
        "`intendedPath=file.md`. Client 0's LocalCreate POST then drains " +
        "and the server deconflicts (because Client 0's lastSeenVaultUpdateId " +
        "now equals D's creation, so the merge condition fails) — creating " +
        "a sibling doc D' at `file (1).md`. The convergence path then " +
        "needs `unwindReadyStashes` to slide D off the conflict-uuid stash " +
        "back to file.md once Client 0's local file moves to file (1).md, " +
        "leaving both clients with [file.md, file (1).md]. Documents the " +
        "displacement-then-deconflict-then-unwind path the fix to " +
        "`processCreate`'s same-docId orphan cleanup must not regress.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "pause-websocket", client: 0 },

        { type: "create", client: 1, path: "file.md", content: "from-1\n" },
        { type: "sync", client: 1 },

        { type: "pause-server" },

        { type: "resume-websocket", client: 0 },

        // Yield long enough for the drain to traverse all the microtask
        // hops between the WS handler and the GET, so the request is
        // queued at the (paused) server before the local create runs.
        { type: "sleep", ms: 50 },

        { type: "create", client: 0, path: "file.md", content: "from-0\n" },

        { type: "resume-server" },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(2);
                s.assertFileExists("file.md");
                s.assertFileExists("file (1).md");
                s.assertAnyFileContains("from-0");
                s.assertAnyFileContains("from-1");
            }
        }
    ]
};
