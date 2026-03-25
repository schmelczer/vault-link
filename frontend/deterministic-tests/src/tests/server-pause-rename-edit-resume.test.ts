import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyRenamedAndEdited(state: ClientState): void {
    const files = Array.from(state.files.keys());
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${files.join(", ")}`
    );
    assert(
        !state.files.has("A.md"),
        `A.md should not exist after rename`
    );
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist, got: ${files.join(", ")}`
    );
    const content = state.files.get("B.md") ?? "";
    assert(
        content === "edited after rename during pause",
        `Expected B.md content to be "edited after rename during pause", got: "${content}"`
    );
}

/**
 * Tests that a rename + edit while the server is paused both propagate
 * correctly after resume. The event coalescing should produce a
 * move-and-update action. When the server resumes and processes the
 * stalled request, both the path change and content change should
 * apply atomically.
 *
 * This exercises the coalescing path: move + update = move-and-update.
 */
export const serverPauseRenameEditResumeTest: TestDefinition = {
    name: "Server Pause: Rename + Edit Then Resume",
    description:
        "Client 0 creates A.md and syncs. Server is paused. Client 0 " +
        "renames A.md to B.md and edits B.md. Server resumes. Both the " +
        "rename and edit should propagate to Client 1.",
    clients: 2,
    steps: [
        // Setup: create and sync
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "original content"
        },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "A.md",
            content: "original content"
        },

        // Pause server
        { type: "pause-server" },

        // Rename and edit while server is paused
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        {
            type: "update",
            client: 0,
            path: "B.md",
            content: "edited after rename during pause"
        },

        // Resume server
        { type: "resume-server" },

        { type: "sync" },
        { type: "barrier" },

        // Both clients should have B.md with edited content
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-consistent", verify: verifyRenamedAndEdited }
    ]
};
