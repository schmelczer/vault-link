import type { TestDefinition } from "../test-definition";

/**
 * Write/Write Conflict Test
 *
 * Scenario:
 * - Client 0 creates file A with content "hello"
 * - Client 1 creates file A with content "world"
 * - Both clients sync
 * - The system must resolve the conflict deterministically
 *
 * Expected behavior:
 * - One version wins (typically last-write-wins or version-based)
 * - Both clients converge to the same final state
 */
export const writeWriteConflictTest: TestDefinition = {
    name: "Write/Write Conflict",
    description:
        "Two clients simultaneously create the same file with different content. " +
        "The system should resolve the conflict and both clients should converge.",
    clients: 2,
    steps: [
        // Both clients go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Both clients create the same file with different content
        { type: "create", client: 0, path: "A.md", content: "hello" },
        { type: "create", client: 1, path: "A.md", content: "world" },

        // Enable sync and wait for conflict resolution
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        // Wait for sync to complete and propagate
        { type: "barrier" },

        // Extra time for any conflict resolution
        { type: "wait", duration: 300 },

        { type: "barrier" },

        // Verify both clients have the same file(s) and content
        { type: "assert-consistent" }
    ]
};
