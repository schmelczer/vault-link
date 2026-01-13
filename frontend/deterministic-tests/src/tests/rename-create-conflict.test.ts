import type { TestDefinition } from "../test-definition";

/**
 * Rename-Create Conflict Test
 *
 * Scenario:
 * - Client 0 creates file A with content "hi" and syncs it
 * - Client 1 syncs (now has A with "hi")
 * - Client 0 disables sync (disconnects WebSocket)
 * - Client 1 renames A to B and syncs
 * - Client 0 (offline, unaware of the rename) creates file B with content "hi"
 * - Client 0 enables sync again
 * - Both clients sync
 *
 * Expected behavior:
 * - The system must resolve the conflict deterministically
 * - Client 0's create of B conflicts with Client 1's rename of A to B
 * - Possible resolutions:
 *   1. One file wins (B contains one version)
 *   2. Files are merged/renamed to avoid collision
 *   3. One operation is rejected
 * - Both clients must converge to a consistent state
 */
export const renameCreateConflictTest: TestDefinition = {
    name: "Rename-Create Conflict",
    description:
        "Client 0 creates file A, Client 1 renames A to B, then Client 0 (without syncing) creates B. " +
        "The system must resolve the conflict deterministically.",
    clients: 2,
    steps: [
        // Enable sync on all clients first (agents start with sync disabled)
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        // Client 0 creates file A with "hi" and syncs
        { type: "create", client: 0, path: "A.md", content: "hi" },
        { type: "sync", client: 0 },

        // Client 1 syncs to get file A
        { type: "sync", client: 1 },
        { type: "assert-exists", client: 1, path: "A.md" },
        { type: "assert-content", client: 1, path: "A.md", content: "hi" },

        // IMPORTANT: Disable sync on Client 0 BEFORE Client 1 renames
        // This ensures Client 0 doesn't receive the rename notification via WebSocket
        { type: "disable-sync", client: 0 },

        // Client 1 renames A to B and syncs
        { type: "rename", client: 1, oldPath: "A.md", newPath: "B.md" },
        { type: "sync", client: 1 },

        // Client 0 creates B (without knowing about the rename, since sync is disabled)
        { type: "create", client: 0, path: "B.md", content: "hi" },

        // Now enable sync on Client 0 and let conflict resolution happen
        { type: "enable-sync", client: 0 },

        { type: "barrier" }, // Wait for conflict resolution

        // Give system time to propagate
        { type: "wait", duration: 500 },

        { type: "barrier" },

        // Verify both clients converge to the same state
        { type: "assert-consistent" }
    ]
};
