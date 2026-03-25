import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyContent(state: ClientState): void {
    // The file should be at B.md with the exact edited content
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const content = state.files.get("B.md") ?? "";
    assert(
        content === "edited after rename",
        `Expected B.md to be "edited after rename", got: "${content}"`
    );

    // A.md should not exist (renamed away)
    assert(
        !state.files.has("A.md"),
        `A.md should not exist after rename, got: ${Array.from(state.files.keys()).join(", ")}`
    );

    // Only B.md should exist
    assert(
        state.files.size === 1,
        `Expected exactly 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
}

export const offlineRenameAndEditTest: TestDefinition = {
    name: "Offline Rename and Edit",
    description:
        "Client 0 creates A.md and syncs. Client 0 goes offline, renames A.md " +
        "to B.md, then edits B.md. When Client 0 reconnects, the rename and edit " +
        "should both propagate to Client 1.",
    clients: 2,
    steps: [
        // Setup: create and sync
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "A.md", content: "original" },

        // Client 0 goes offline, renames and edits
        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "update", client: 0, path: "B.md", content: "edited after rename" },

        // Client 0 reconnects
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // A.md should be gone, B.md should have edited content
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-consistent", verify: verifyContent }
    ]
};
