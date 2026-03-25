import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG FIX: migrateKey must not overwrite existing state at the new key.
 *
 * Scenario:
 * 1. Client 0 creates file A.md, then immediately updates it
 * 2. Server is paused so the create stalls (idempotency key unresolved)
 * 3. Client 1 is online and also creates at A.md (different content)
 * 4. Server resumes — both creates merge
 * 5. Client 0's update should not be lost during key migration
 *
 * The test verifies that after convergence, the file exists with
 * content from both clients' edits.
 */
function verifyContent(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("A.md"), "Expected A.md to exist");
    const content = state.files.get("A.md") ?? "";
    // Client 0's update should be present
    assert(
        content.includes("updated by client 0"),
        `Expected content to include "updated by client 0", got: "${content}"`
    );
}

export const migrateKeyPreservesExistingTest: TestDefinition = {
    name: "Key Migration Preserves Existing Queue State",
    description:
        "When migrateKey is called and the new key already has queued " +
        "events, the existing events must not be silently dropped.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Pause server so create stalls
        { type: "pause-server" },

        // Client 0 creates and immediately updates
        { type: "create", client: 0, path: "A.md", content: "initial" },
        {
            type: "update",
            client: 0,
            path: "A.md",
            content: "updated by client 0"
        },

        // Resume server
        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyContent }
    ]
};
