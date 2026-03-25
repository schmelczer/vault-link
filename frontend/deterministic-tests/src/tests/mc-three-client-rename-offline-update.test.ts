import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyState(state: ClientState): void {
    // A.md should not exist (it was renamed to B.md by Client 1)
    assert(
        !state.files.has("A.md"),
        `A.md should not exist after rename. Files: ${Array.from(state.files.keys()).join(", ")}`
    );

    // Exactly 1 file should exist (B.md with merged content)
    assert(
        state.files.size === 1,
        `Expected exactly 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );

    // B.md must exist with Client 2's updated content merged in
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist. Files: ${Array.from(state.files.keys()).join(", ")}`
    );
    const content = state.files.get("B.md") ?? "";
    assert(
        content.includes("updated-by-client-2"),
        `Expected B.md to contain "updated-by-client-2", got: "${content}"`
    );
}

export const mcThreeClientRenameOfflineUpdateTest: TestDefinition = {
    name: "MC: Three-Client Rename + Offline Update",
    description:
        "Client 0 creates A.md. Client 1 renames to B.md. Client 2 (offline) " +
        "updates A.md. All three converge with updated content at B.md.",
    clients: 3,
    steps: [
        // Phase 1: Client 0 creates A.md, everyone syncs
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "enable-sync", client: 2 },
        { type: "sync" },
        { type: "barrier" },

        // Phase 2: Client 2 goes offline
        { type: "disable-sync", client: 2 },

        // Phase 3: Client 1 renames A.md -> B.md, clients 0 and 1 sync
        { type: "rename", client: 1, oldPath: "A.md", newPath: "B.md" },
        { type: "sync", client: 1 },
        { type: "sync", client: 0 },
        // Don't use barrier here — Client 2 is offline and can't converge
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-exists", client: 0, path: "B.md" },

        // Phase 4: Client 2 updates its local A.md while offline
        { type: "update", client: 2, path: "A.md", content: "updated-by-client-2" },

        // Phase 5: Client 2 reconnects
        { type: "enable-sync", client: 2 },
        { type: "sync" },
        { type: "barrier" },

        // All three must converge
        { type: "assert-consistent", verify: verifyState }
    ]
};
