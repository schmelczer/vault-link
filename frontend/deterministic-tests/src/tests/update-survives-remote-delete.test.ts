import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG FIX: Local edit must survive a concurrent remote delete.
 *
 * Scenario:
 * 1. Both clients have doc.md = "original"
 * 2. Client 0 deletes doc.md
 * 3. Client 1 edits doc.md to "edited by client 1"
 * 4. Client 0 syncs first (delete reaches server)
 * 5. Client 1 syncs — sees remote delete, but local edit takes precedence
 * 6. Client 1 creates a NEW document at doc.md with the edited content
 */
function verifyEditSurvived(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("doc.md"), "Expected doc.md to exist");
    const content = state.files.get("doc.md") ?? "";
    assert(
        content.includes("edited by client 1"),
        `Expected content to include "edited by client 1", got: "${content}"`
    );
}

export const updateSurvivesRemoteDeleteTest: TestDefinition = {
    name: "Local Edit Survives Remote Delete",
    description:
        "When a user edits a file and another client deletes it concurrently, " +
        "the local edit should take precedence and the file should survive.",
    clients: 2,
    steps: [
        // Setup
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Client 0 deletes, client 1 edits
        { type: "delete", client: 0, path: "doc.md" },
        { type: "update", client: 1, path: "doc.md", content: "edited by client 1" },

        // Client 0 goes online first — delete reaches server before
        // Client 1 reconnects. This ensures Client 1's update sees
        // the remote delete and falls back to creating a new document.
        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },

        // Client 1 goes online — remote delete coalesces with local edit
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyEditSurvived },
    ],
};
