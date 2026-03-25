import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * EDGE CASE: Rename to the path of a document whose delete hasn't been
 * confirmed on the server yet.
 *
 * The VFS move() method (vfs.ts line 494-497) silently removes any existing
 * document at the target path from the pathIndex. If the target path holds
 * a tracked document that is about to be deleted (but the delete hasn't
 * been sent to the server yet), the move will remove it from pathIndex,
 * potentially causing a deleted-locally document to lose its path reference.
 *
 * Scenario:
 * 1. Both clients have A.md and B.md
 * 2. Client 0 goes offline, deletes A.md, renames B.md → A.md
 * 3. On reconnect:
 *    - The delete of A.md is queued
 *    - The rename of B.md → A.md needs VFS.move(B.md, A.md)
 *    - But A.md is still in pathIndex (tracked, not yet deleted)
 *    - VFS.move removes A.md from pathIndex before the delete is confirmed
 *
 * Expected: A.md's documentId is deleted on server, B.md's document
 * is renamed to A.md, both clients converge.
 */
function verifyFinalState(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(state.files.has("A.md"), "Expected A.md to exist");
    const content = state.files.get("A.md") ?? "";
    assert(
        content === "content B",
        `Expected "content B", got: "${content}"`
    );
}

export const renameToPathOfUnconfirmedDeleteTest: TestDefinition = {
    name: "Rename to Path of Unconfirmed Delete",
    description:
        "Client deletes A.md and renames B.md to A.md while offline. " +
        "On reconnect, the VFS must handle the path conflict between " +
        "the tracked A.md (pending delete) and the rename destination.",
    clients: 2,
    steps: [
        // Setup: both clients have A.md and B.md
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "content A"
        },
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "content B"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline
        { type: "disable-sync", client: 0 },

        // Delete A.md, then rename B.md → A.md
        { type: "delete", client: 0, path: "A.md" },
        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },

        // Reconnect
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Should converge: A.md exists with B's content, B.md gone
        { type: "assert-not-exists", client: 0, path: "B.md" },
        { type: "assert-not-exists", client: 1, path: "B.md" },
        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
