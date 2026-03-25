import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyConvergence(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();

    // A.md should not exist (it was renamed/deleted)
    assert(
        !state.files.has("A.md"),
        `A.md should not exist. Files: ${files.join(", ")}`
    );

    // B.md should still exist unaffected
    assert(
        state.files.has("B.md"),
        `B.md should exist (untouched). Files: ${files.join(", ")}`
    );
    assert(
        state.files.get("B.md") === "content-b",
        `B.md should have "content-b", got: "${state.files.get("B.md")}"`
    );

    // Clients must converge. If delete wins, A_renamed.md shouldn't exist.
    // If rename wins, A_renamed.md should exist with content-a.
    // Either way, both clients must agree.
    if (state.files.has("A_renamed.md")) {
        assert(
            state.files.get("A_renamed.md") === "content-a",
            `If A_renamed.md exists, it should have "content-a", got: "${state.files.get("A_renamed.md")}"`
        );
    }
}

export const offlineDeleteRemoteRenameTest: TestDefinition = {
    name: "Offline Delete + Concurrent Remote Rename",
    description:
        "Client 0 goes offline and deletes A.md locally. Meanwhile Client 1 " +
        "renames A.md to A_renamed.md and syncs. When Client 0 reconnects, " +
        "the offline reconciliation discovers A.md is missing locally but the " +
        "server has it renamed. The system must converge consistently.",
    clients: 2,
    steps: [
        // Setup
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline and deletes A.md
        { type: "disable-sync", client: 0 },
        { type: "delete", client: 0, path: "A.md" },

        // Client 1 renames A.md -> A_renamed.md
        {
            type: "rename",
            client: 1,
            oldPath: "A.md",
            newPath: "A_renamed.md"
        },
        { type: "sync", client: 1 },

        // Client 0 reconnects
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients must converge
        { type: "assert-consistent", verify: verifyConvergence }
    ]
};
