import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const conflictUuidStashClearedAfterRenameDeconflictTest: TestDefinition =
{
    description:
        "A `RemoteChange` for a brand-new doc D2 at `target.md` reaches " +
        "Client 1's queue *before* Client 1's user-rename of D1 → " +
        "`target.md`. The rename's `queue.enqueue` mutates " +
        "`documents` synchronously, so by the time the drain processes " +
        "the buffered broadcast, `target.md` is already tracked by D1 " +
        "with a high `parentVersionId`. " +
        "`processRemoteCreateForNewDocument`'s version comparison " +
        "(`parentVersionId < remoteVaultUpdateId`) takes the " +
        "`MoveOnConflict.NEW` branch and stashes D2 at " +
        "`conflict-<uuid>-target.md`. The rename's `LocalUpdate` then " +
        "drains, the server deconflicts D1 to `target (1).md`, freeing " +
        "the `target.md` slot locally — but D2 is left orphaned at the " +
        "`conflict-<uuid>-` path forever, diverging from Client 0 which " +
        "has D2 at `target.md`.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        // Both clients have D1 at `original.md`.
        {
            type: "create",
            client: 0,
            path: "original.md",
            content: "D1 v1\n"
        },
        { type: "barrier" },

        // Buffer Client 1's WebSocket so D2's broadcast doesn't land
        // until we're ready to enqueue it ahead of the rename.
        { type: "pause-websocket", client: 1 },

        // Client 0 creates D2 at target.md. Server stores it; broadcast
        // is buffered at Client 1.
        {
            type: "create",
            client: 0,
            path: "target.md",
            content: "D2 v1\n"
        },
        { type: "sync", client: 0 },

        // Pause the server. Now Client 1's next HTTP PUT will buffer in
        // TCP and the drain will sit on `await sendUpdate`.
        { type: "pause-server" },

        // Issue an update to D1. The drain pops the LocalUpdate and
        // suspends on the HTTP PUT (server is SIGSTOPped). The drain is
        // now busy and won't pop further events until resume-server.
        {
            type: "update",
            client: 1,
            path: "original.md",
            content: "D1 v2\n"
        },

        // Replay the buffered D2 broadcast. It enqueues as a
        // RemoteChange BEHIND the in-flight LocalUpdate but AHEAD of
        // the rename event we're about to push.
        { type: "resume-websocket", client: 1 },

        // User renames D1 onto target.md. `queue.enqueue` synchronously
        // updates `documents` so target.md → D1. The rename's
        // LocalUpdate is pushed to the END of the queue, *after* the
        // buffered RemoteChange.
        {
            type: "rename",
            client: 1,
            oldPath: "original.md",
            newPath: "target.md"
        },

        // Resume the server. Drain order: (1) finish the v2 update PUT
        // → D1.parentVersionId bumps above D2's vaultUpdateId. (2)
        // process the RemoteChange for D2 — sees `documents.get(target.md)
        // = D1` with parentVersionId > vaultUpdateId → MoveOnConflict.NEW
        // → stashes D2 at `conflict-<uuid>-target.md`. (3) process the
        // rename's LocalUpdate — server deconflicts to target (1).md;
        // local file moves there.
        { type: "resume-server" },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(2);
                state.assertFileExists("target.md");
                state.assertFileExists("target (1).md");
                state.assertContent("target.md", "D2 v1\n");
                state.assertContent("target (1).md", "D1 v2\n");
            }
        }
    ]
};
