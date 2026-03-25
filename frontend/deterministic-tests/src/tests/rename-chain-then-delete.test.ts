import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyAllDeleted(state: ClientState): void {
    const files = Array.from(state.files.keys());
    assert(
        state.files.size === 0,
        `Expected no files (document was deleted after rename chain), got ${state.files.size}: ${files.join(", ")}`
    );
}

export const renameChainThenDeleteTest: TestDefinition = {
    name: "Rename Chain Then Delete (Offline Catchup)",
    description:
        "Client 0 creates X.md and syncs. Client 1 goes offline. Client 0 " +
        "renames X.md -> Y.md -> Z.md, then deletes Z.md. Client 1 reconnects " +
        "with X.md still on disk. The offline reconciliation must detect that " +
        "the document was deleted (despite the rename chain) and remove X.md.",
    clients: 2,
    steps: [
        // Setup: create and sync
        { type: "create", client: 0, path: "X.md", content: "chain-content" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "X.md",
            content: "chain-content"
        },

        // Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Client 0: rename chain X -> Y -> Z, then delete Z
        {
            type: "rename",
            client: 0,
            oldPath: "X.md",
            newPath: "Y.md"
        },
        { type: "sync", client: 0 },
        {
            type: "rename",
            client: 0,
            oldPath: "Y.md",
            newPath: "Z.md"
        },
        { type: "sync", client: 0 },
        { type: "delete", client: 0, path: "Z.md" },
        { type: "sync", client: 0 },

        // Client 1 reconnects — should detect X.md's document is deleted
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients must agree: no files
        { type: "assert-consistent", verify: verifyAllDeleted }
    ]
};
