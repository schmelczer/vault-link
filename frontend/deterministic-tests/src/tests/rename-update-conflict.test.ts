import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyConvergence(state: ClientState): void {
    const files = Array.from(state.files.keys());
    // A.md should not exist (it was renamed to B.md by client 0)
    assert(
        !files.includes("A.md"),
        `Expected A.md to not exist after rename, but found files: ${files.join(", ")}`
    );
    // B.md should exist (the rename target)
    assert(
        files.includes("B.md"),
        `Expected B.md to exist after rename, but found files: ${files.join(", ")}`
    );
    // B.md should contain client 1's update (merged with the rename)
    const content = state.files.get("B.md") ?? "";
    assert(
        content.includes("updated"),
        `Expected B.md to contain "updated" from client 1's edit, got: "${content}"`
    );
}

export const renameUpdateConflictTest: TestDefinition = {
    name: "Rename vs Update Conflict",
    description:
        "Client 0 renames A.md to B.md while Client 1 (offline) updates A.md. " +
        "When Client 1 reconnects, the update should be applied to B.md (the " +
        "renamed file) via 3-way merge. Both clients should converge.",
    clients: 2,
    steps: [
        // Setup: create A.md and sync to both clients
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "A.md", content: "original" },

        // Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Client 0 renames A.md to B.md and syncs
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "sync", client: 0 },

        // Client 1 (offline) updates A.md
        { type: "update", client: 1, path: "A.md", content: "updated by client 1" },

        // Client 1 reconnects — must reconcile rename with update
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "barrier" },

        // Verify convergence
        { type: "assert-consistent", verify: verifyConvergence }
    ]
};
