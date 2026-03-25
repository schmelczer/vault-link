import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyConflictResolution(state: ClientState): void {
    const files = Array.from(state.files.keys());

    // B.md must exist (unaffected by the conflict)
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist, got: ${files.join(", ")}`
    );
    assert(
        state.files.get("B.md") === "content-b",
        `Expected B.md to have "content-b", got: "${state.files.get("B.md")}"`
    );

    // A.md should not exist (either deleted or renamed away)
    assert(
        !state.files.has("A.md"),
        `A.md should not exist after conflict resolution, got: ${files.join(", ")}`
    );

    // If C.md exists (rename won over delete), it should have content-a
    if (state.files.has("C.md")) {
        assert(
            state.files.get("C.md") === "content-a",
            `If C.md exists, it should have "content-a", got: "${state.files.get("C.md")}"`
        );
    }
}

export const deleteRenameConflictTest: TestDefinition = {
    name: "Delete vs Rename Conflict",
    description:
        "Client 0 deletes A.md while Client 1 (offline) renames A.md to C.md. " +
        "When Client 1 reconnects, the system must reconcile the conflicting " +
        "operations. Both clients should converge to the same state.",
    clients: 2,
    steps: [
        // Setup: create A.md and B.md, sync to both clients
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-exists", client: 1, path: "A.md" },
        { type: "assert-exists", client: 1, path: "B.md" },

        // Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Client 0 deletes A.md and syncs
        { type: "delete", client: 0, path: "A.md" },
        { type: "sync", client: 0 },

        // Client 1 (offline) renames A.md to C.md
        { type: "rename", client: 1, oldPath: "A.md", newPath: "C.md" },

        // Client 1 reconnects
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "barrier" },

        // Both clients must converge — the key invariant is consistency.
        // B.md should still exist on both (unaffected by the conflict).
        { type: "assert-exists", client: 0, path: "B.md" },
        { type: "assert-exists", client: 1, path: "B.md" },
        { type: "assert-consistent", verify: verifyConflictResolution }
    ]
};
