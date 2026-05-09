import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const remoteUpdateSurvivesUserRenameTest: TestDefinition = {
    description:
        "Client 0 updates a tracked doc; while Client 1 is processing the " +
        "broadcast and parked on the GET for the new version's content, the " +
        "user renames the doc on Client 1. Pre-fix: `processRemoteUpdate` " +
        "captures `actualPath` before the await and, after the GET returns, " +
        "calls `write(actualPath, …)` (no-op — file was renamed away), " +
        "`updateCache(actualPath, …)`, and `setDocument(actualPath, …)`. " +
        "`setDocument` mutates the same record in place so its `path` is " +
        "yanked from the user's renamed slot back to the pre-rename path, " +
        "wiping the rename out of the queue's documents map. The queued " +
        "`LocalUpdate` then reads from the now-stale `record.path`, hits " +
        "`FileNotFoundError`, and is silently dropped — the user's rename " +
        "never reaches the server. Post-fix: the handler defers when a " +
        "local event landed mid-await, so the rename drains first and " +
        "the deferred remote update is folded into the broadcast that " +
        "follows the rename round-trip.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "v1\n" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        // Buffer Client 1's incoming broadcasts so it doesn't see
        // Client 0's update until we've paused the server.
        { type: "pause-websocket", client: 1 },

        // Server now holds v=2 of doc.md.
        { type: "update", client: 0, path: "doc.md", content: "v2\n" },
        { type: "sync", client: 0 },

        // Pause the server. Client 1's upcoming GET for the new version
        // content blocks at the OS layer until resume.
        { type: "pause-server" },

        // Release the buffered broadcast. Client 1's drain enters
        // `processRemoteUpdate`, captures `actualPath`, fires the GET,
        // and parks awaiting the response.
        { type: "resume-websocket", client: 1 },

        // Yield long enough for the drain to traverse all microtask
        // hops between the WS handler and the GET, so the HTTP request
        // is queued at the (paused) server before the rename runs.
        // Without this yield the rename would be enqueued before
        // `processRemoteUpdate`'s entry-time `hasPendingLocalEvents`
        // check and the early-defer branch would mask the bug.
        { type: "sleep", ms: 50 },

        // While the GET is in flight the user renames the doc. The queue
        // mutates `record.path` to "renamed.md" in place and pushes a
        // LocalUpdate carrying the rename target.
        {
            type: "rename",
            client: 1,
            oldPath: "doc.md",
            newPath: "renamed.md"
        },

        // Resume the server. The GET response unblocks
        // `processRemoteUpdate`. With the fix in place it sees the
        // queued LocalUpdate and defers; without the fix it walks past
        // the rename and clobbers the documents map, dropping the
        // pending LocalUpdate's read on the way back through.
        { type: "resume-server" },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1);
                s.assertFileExists("renamed.md");
                s.assertFileNotExists("doc.md");
                // Both edits survive: the user's rename and Client 0's
                // content update at v=2.
                s.assertContent("renamed.md", "v2\n");
            }
        }
    ]
};
