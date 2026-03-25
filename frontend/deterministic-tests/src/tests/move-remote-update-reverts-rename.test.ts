import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: remote-update + local-move = remote-update loses the rename.
 *
 * In sync-events.ts coalesceFromRemoteUpdate (line 271-272):
 *   case "local-move":
 *       return current;  // remote-update absorbs the local-move
 *
 * When a remote-update broadcast arrives and then the user renames the
 * file, the coalescing discards the move info. The executor only sees
 * "remote-update" and calls executeSyncUpdateFull(force=true).
 *
 * In the force path (no local content changes), the server responds
 * with the old path. The client moves the file BACK to the old path,
 * reverting the user's rename.
 *
 * If there ARE content changes, the update sends doc.relativePath (the
 * new path) to the server, which may preserve the rename. But the
 * behavior is inconsistent.
 *
 * This test verifies that when a remote-update and a local-rename race,
 * the rename is preserved (or at least both clients converge).
 */
function verifyState(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    // The file should exist at the renamed path or original — either is OK
    // as long as both clients converge. But ideally the rename survives.
    const content = Array.from(state.files.values())[0];
    assert(
        content === "updated by client 1",
        `Expected "updated by client 1", got: "${content}"`
    );
}

export const moveRemoteUpdateRevertsRenameTest: TestDefinition = {
    name: "Remote Update + Local Move Coalescing May Revert Rename",
    description:
        "When a remote-update broadcast arrives and the user renames the " +
        "file, the coalescing (remote-update + local-move = remote-update) " +
        "discards the rename info. The force path may revert the rename " +
        "by moving the file back to the server's path.",
    clients: 2,
    steps: [
        // Setup: both clients have doc.md
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 1 updates the file content (broadcasts to client 0)
        { type: "disable-sync", client: 0 },
        { type: "update", client: 1, path: "doc.md", content: "updated by client 1" },
        { type: "sync", client: 1 },

        // Client 0 comes online and renames the file while the remote-update
        // is arriving on the WebSocket
        { type: "enable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "doc.md", newPath: "renamed.md" },
        { type: "sync" },
        { type: "barrier" },

        // Both should converge
        { type: "assert-consistent", verify: verifyState }
    ]
};
