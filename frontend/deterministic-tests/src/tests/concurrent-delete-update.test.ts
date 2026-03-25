import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyConflictResolution(state: ClientState): void {
    // Either the delete wins (no files) or the update wins (A.md with
    // updated content). Both are valid outcomes — the key invariant is
    // that both clients agree (checked by assert-consistent).
    if (state.files.has("A.md")) {
        assert(
            state.files.get("A.md") === "updated offline",
            `If A.md survived, it should have "updated offline", got: "${state.files.get("A.md")}"`
        );
    }
}

export const concurrentDeleteUpdateTest: TestDefinition = {
    name: "Concurrent Delete and Update",
    description:
        "Client 0 and Client 1 have A.md synced. Client 0 deletes A.md while " +
        "Client 1 (offline) updates A.md. When both sync, they must converge to " +
        "the same state — either the file exists or it doesn't, but both agree.",
    clients: 2,
    steps: [
        // Setup: create and sync A.md
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 1 goes offline, updates the file
        { type: "disable-sync", client: 1 },
        { type: "update", client: 1, path: "A.md", content: "updated offline" },

        // Client 0 deletes and syncs
        { type: "delete", client: 0, path: "A.md" },
        { type: "sync", client: 0 },

        // Client 1 reconnects with pending update
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "barrier" },

        // Key invariant: both clients must agree on the state.
        // If A.md survived the conflict, it must have the updated content.
        { type: "assert-consistent", verify: verifyConflictResolution }
    ]
};
