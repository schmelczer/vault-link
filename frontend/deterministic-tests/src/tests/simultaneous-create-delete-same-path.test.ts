import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyConflictResolution(state: ClientState): void {
    // The delete and offline update conflict on the same document.
    // Either outcome is acceptable — the key invariant is convergence
    // (checked by assert-consistent). But we verify content correctness
    // for whichever outcome the system chose.
    if (state.files.has("A.md")) {
        // Update won: A.md should have the offline-modified content
        assert(
            state.files.get("A.md") === "modified by 1 while offline",
            `If A.md survived, it should have "modified by 1 while offline", got: "${state.files.get("A.md")}"`
        );
        assert(
            state.files.size === 1,
            `Expected exactly 1 file if update won, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
        );
    } else {
        // Delete won: no files should exist
        assert(
            state.files.size === 0,
            `Expected 0 files if delete won, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
        );
    }
}

export const simultaneousCreateDeleteSamePathTest: TestDefinition = {
    name: "Simultaneous Create and Delete at Same Path",
    description:
        "Client 0 creates A.md and syncs to both clients. Client 0 deletes A.md while " +
        "Client 1 (offline) updates A.md with different content. When Client 1 reconnects, " +
        "the update and delete must be reconciled. Both clients must converge.",
    clients: 2,
    steps: [
        // Setup: Client 0 creates and syncs A.md
        { type: "create", client: 0, path: "A.md", content: "original from 0" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Client 0 deletes A.md
        { type: "delete", client: 0, path: "A.md" },
        { type: "sync", client: 0 },

        // Client 1 updates A.md while offline (it still has it)
        { type: "update", client: 1, path: "A.md", content: "modified by 1 while offline" },

        // Client 1 reconnects
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "barrier" },

        // Both must agree — key invariant is convergence
        { type: "assert-consistent", verify: verifyConflictResolution }
    ]
};
