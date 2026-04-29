import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const disableSyncMidCreateNoDuplicateTest: TestDefinition = {
    description:
        "Client 0 creates `doc.md`. While the create's HTTP roundtrip is in " +
        "flight (server paused), the user disables sync. Pre-fix: " +
        "`SyncClient.pause()` calls `fetchController.startReset()`, which " +
        "rejects the in-flight fetch with `SyncResetError`. The server " +
        "still commits the document, but the client never learns the " +
        "docId. The user then renames the file offline (`doc.md` -> " +
        "`renamed.md`) and re-enables sync. The offline scan sees " +
        "`renamed.md` as an untracked new file (the create's record was " +
        "never settled) and creates a SECOND document on the server with " +
        "the same content. WS catch-up then downloads the orphaned first " +
        "doc back to `doc.md`, leaving the client with two files holding " +
        "identical content. Post-fix: `pause({abortInFlight: false})` " +
        "lets the create's HTTP land, the docId is captured into " +
        "`queue.documents`, and the offline scan recognises `renamed.md` " +
        "as a rename of an already-tracked doc — only one server doc " +
        "exists.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        // Pause the server so the upcoming create's HTTP buffers at the
        // OS level. The fetch is in flight from the client's perspective
        // — exactly the state where pre-fix `startReset` would discard
        // its eventual response.
        { type: "pause-server" },

        { type: "create", client: 0, path: "doc.md", content: "marker\n" },

        // Disable sync. Pre-fix: aborts the in-flight create with
        // SyncResetError; the server commits but the client forgets.
        // Post-fix: blocks until the in-flight HTTP lands; queue
        // records the doc.
        { type: "resume-server" },
        { type: "disable-sync", client: 0 },

        // User renames the file while offline.
        { type: "rename", client: 0, oldPath: "doc.md", newPath: "renamed.md" },

        // Re-enable sync. Post-fix: offline scan sees `renamed.md` as a
        // rename of the tracked doc and PUTs a rename to the server.
        // Pre-fix: scan sees `renamed.md` as new (queue.documents is
        // empty for it) and CREATEs a second doc; WS catch-up later
        // re-downloads the orphaned first doc to `doc.md`.
        { type: "enable-sync", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(1);
                state.assertFileExists("renamed.md");
                state.assertFileNotExists("doc.md");
                state.assertContent("renamed.md", "marker\n");
            }
        }
    ]
};
