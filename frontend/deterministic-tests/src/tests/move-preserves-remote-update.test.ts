import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG FIX: Local rename must not drop a concurrent remote content update.
 *
 * Scenario:
 * 1. Both clients have doc.md = "line 1\nline 2"
 * 2. Client 0 renames doc.md to renamed.md
 * 3. Client 1 edits doc.md content
 * 4. Both sync
 * 5. The file should exist (at some path) with both the rename and content update applied
 */
function verifyContentPreserved(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    // The file should be at the renamed path
    assert(
        state.files.has("renamed.md") || state.files.has("doc.md"),
        `Expected file at renamed.md or doc.md, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    // Content from client 1's edit should be present
    const [content] = [...state.files.values()];
    assert(
        content.includes("client 1 edit"),
        `Expected merged content to include "client 1 edit", got: "${content}"`
    );
}

export const movePreservesRemoteUpdateTest: TestDefinition = {
    name: "Local Move Preserves Remote Content Update",
    description:
        "When a user renames a file and another client edits it concurrently, " +
        "the content update should not be lost.",
    clients: 2,
    steps: [
        // Setup
        { type: "create", client: 0, path: "doc.md", content: "line 1\nline 2" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Client 0 renames, client 1 edits content
        { type: "rename", client: 0, oldPath: "doc.md", newPath: "renamed.md" },
        { type: "update", client: 1, path: "doc.md", content: "line 1\nclient 1 edit\nline 2" },

        // Both come online
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyContentPreserved },
    ],
};
