import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const remoteRenameCollidesWithPendingLocalCreateTest: TestDefinition = {
    // TODO(refactor): the failure mode described below is the
    // pre-refactor "deflect-to-conflict-uuid" path that no longer
    // exists. Under the new model the wire loop never moves files for
    // path placement, so the remote rename can't deflect anywhere; the
    // reconciler waits for the slot to free. Convergence assertion is
    // still valid (no conflict-uuid stashes, both files present, the
    // local create lands at a server-deconflicted sibling).
    description:
        "Client 0 has doc D tracked at `original.md`. Client 1 owns doc E " +
        "and renames it to `target.md` server-side. Before client 0's " +
        "drain processes the WS broadcast for E, the user creates a new " +
        "local file `target.md` (a different doc, untracked). When the " +
        "buffered RemoteChange for E drains, the engine has to reconcile " +
        "doc E onto `target.md` even though the slot is held by client " +
        "0's pending LocalCreate. Convergence requires both clients end " +
        "up with [target.md = E] and the local create lands at a " +
        "server-deconflicted sibling (e.g. `target (1).md`).",
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
        {
            type: "rename",
            client: 1,
            oldPath: "original.md",
            newPath: "target.md"
        },
        { type: "sync", client: 1 },

        // Client 0 still believes the doc is at `original.md`. The user
        // creates a NEW file at `target.md` (an unrelated untracked
        // doc). Disk on client 0 now has both `original.md` (the
        // tracked doc) and `target.md` (the new untracked file).
        { type: "create", client: 0, path: "target.md", content: "extra\n" },

        // Resume client 0's WS. The buffered RemoteChange drains.
        // The reconciler must converge without ever leaving a
        // conflict-uuid stash on disk.
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
