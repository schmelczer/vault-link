import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyState(state: ClientState): void {
    const files = Array.from(state.files.keys());

    // B.md must exist with updated content from client 1
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist, got: ${files.join(", ")}`
    );
    const bContent = state.files.get("B.md") ?? "";
    assert(
        bContent.includes("updated"),
        `Expected B.md to contain "updated", got: "${bContent}"`
    );

    // C.md must exist (created independently, unaffected)
    assert(
        state.files.has("C.md"),
        `Expected C.md to exist, got: ${files.join(", ")}`
    );

    // A.md should not exist (deleted by client 0 or renamed by client 1)
    assert(
        !state.files.has("A.md"),
        `A.md should not exist, got: ${files.join(", ")}`
    );

    // D.md: Client 1 renamed the server-deleted A.md to D.md offline.
    // The system may keep D.md (rename wins) or drop it (delete wins).
    // If D.md exists, it should have the original content.
    if (state.files.has("D.md")) {
        assert(
            state.files.get("D.md") === "content-a",
            `If D.md exists, it should have "content-a", got: "${state.files.get("D.md")}"`
        );
    }
}

export const multiFileOperationsTest: TestDefinition = {
    name: "Multi-File Operations",
    description:
        "Client 0 creates A.md, B.md, C.md. Both clients sync. Client 1 goes offline. " +
        "Client 0 deletes A.md. Client 1 (offline) updates B.md and renames A.md to D.md. " +
        "When Client 1 reconnects, the system must reconcile: A.md deleted on server, " +
        "renamed on client 1; B.md updated on client 1. Both must converge.",
    clients: 2,
    steps: [
        // Setup: create three files and sync
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "create", client: 0, path: "C.md", content: "content-c" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Client 0 deletes A.md and syncs
        { type: "delete", client: 0, path: "A.md" },
        { type: "sync", client: 0 },

        // Client 1 (offline) updates B.md and renames A.md to D.md
        { type: "update", client: 1, path: "B.md", content: "updated by client 1" },
        { type: "rename", client: 1, oldPath: "A.md", newPath: "D.md" },

        // Client 1 reconnects
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },
        { type: "barrier" },

        // Verify convergence: B.md and C.md must exist. B.md must have update.
        { type: "assert-consistent", verify: verifyState }
    ]
};
