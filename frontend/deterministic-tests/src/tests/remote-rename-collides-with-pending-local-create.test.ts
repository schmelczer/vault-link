import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const remoteRenameCollidesWithPendingLocalCreateTest: TestDefinition = {
    description:
        "Client 0 has doc D tracked at `original.md`. Client 1 owns doc E " +
        "and renames it to `target.md` server-side. Before client 0's " +
        "drain processes the WS broadcast for E, the user creates a new " +
        "local file `target.md` (a different doc, untracked). When the " +
        "buffered RemoteChange for E drains, `processRemoteUpdate` " +
        "tries to move client 0's tracked file from its old slot onto " +
        "`target.md`. Pre-fix: `MoveOnConflict.NEW` deflects the remote " +
        "rename to a `conflict-<uuid>-target.md` stash on client 0, " +
        "leaving a permanent local-only divergence (client 1 has no " +
        "such stash). Post-fix: when the slot is held by a non-tracked " +
        "file (typically the agent's own pending LocalCreate), " +
        "`processRemoteUpdate` uses `MoveOnConflict.EXISTING` to " +
        "displace it; `updatePendingCreatePath` retargets the displaced " +
        "create's `event.path`, so its drain reads the file from the " +
        "new location and the server's deconflict on its create lands " +
        "the new doc at a clean path.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        { type: "create", client: 1, path: "original.md", content: "v1\n" },
        { type: "barrier" },

        // Pause client 0's WS so the upcoming remote rename buffers and
        // we can stage a colliding local create before the rename
        // drains on client 0.
        { type: "pause-websocket", client: 0 },

        // Client 1 renames the doc. Server commits, broadcasts to
        // client 0 (buffered).
        { type: "rename", client: 1, oldPath: "original.md", newPath: "target.md" },
        { type: "sync", client: 1 },

        // Client 0 still believes the doc is at `original.md`. The user
        // creates a NEW file at `target.md` (an unrelated untracked
        // doc). Disk on client 0 now has both `original.md` (the
        // tracked doc) and `target.md` (the new untracked file).
        { type: "create", client: 0, path: "target.md", content: "extra\n" },

        // Resume client 0's WS. The buffered RemoteChange drains.
        // Pre-fix: `MoveOnConflict.NEW` deflects the rename of the
        // tracked doc into `conflict-<uuid>-target.md`, with
        // `intendedPath=target.md`.
        { type: "resume-websocket", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(2);
                for (const path of state.files.keys()) {
                    if (path.startsWith("conflict-")) {
                        throw new Error(
                            `Unexpected conflict-uuid stash on a converged client: ${path}`
                        );
                    }
                }
                state.assertFileExists("target.md");
                state.assertContent("target.md", "v1\n");
                // The local create gets server-deconflicted to a
                // sibling path (e.g. `target (1).md`).
            }
        }
    ]
};
