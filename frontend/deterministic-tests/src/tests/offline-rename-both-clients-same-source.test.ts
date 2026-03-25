import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG/EDGE CASE: Both clients rename the same file to different targets.
 *
 * Client 0 renames X→Y, Client 1 renames X→Z. Both happen offline.
 * When they reconnect:
 *
 * - Client 0's rename (X→Y) goes through first → server has doc at Y
 * - Client 1's rename (X→Z): Client 1 still has the old metadata
 *   pointing to X.md. But the server moved it to Y.md.
 *
 * The conflict: Client 1 will try to update with relativePath=Z.md
 * and parentVersionId pointing to the old state. The server sees the
 * path changed and processes it as a rename from Y→Z.
 *
 * Expected: The file ends up at one path (last rename wins), and both
 * clients converge. Content should be preserved.
 */
function verifyFinalState(state: ClientState): void {
    // X should not exist (renamed by both)
    assert(
        !state.files.has("X.md"),
        `X.md should not exist, files: ${Array.from(state.files.keys()).join(", ")}`
    );

    // Exactly one file should exist (either Y.md or Z.md)
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );

    // Content should be preserved
    const content = Array.from(state.files.values())[0];
    assert(
        content === "original content",
        `Expected "original content", got: "${content}"`
    );
}

export const offlineRenameBothClientsSameSourceTest: TestDefinition = {
    name: "Both Clients Rename Same File to Different Targets (Offline)",
    description:
        "Client 0 renames X→Y, Client 1 renames X→Z, both offline. " +
        "On reconnect, the conflicting renames should resolve and " +
        "both clients should converge to the same final path.",
    clients: 2,
    steps: [
        // Setup: create X.md
        {
            type: "create",
            client: 0,
            path: "X.md",
            content: "original content"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Client 0: rename X→Y
        { type: "rename", client: 0, oldPath: "X.md", newPath: "Y.md" },

        // Client 1: rename X→Z
        { type: "rename", client: 1, oldPath: "X.md", newPath: "Z.md" },

        // Client 0 reconnects first
        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },

        // Client 1 reconnects
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should converge
        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
