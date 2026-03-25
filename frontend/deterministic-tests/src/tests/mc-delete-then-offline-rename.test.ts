import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * Edge case: Client 0 creates a file, syncs. Client 1 receives it. Then Client
 * 0 deletes the file and syncs. Meanwhile Client 1 goes offline and renames it.
 *
 * Timeline:
 *   1. Client 0 creates A.md, both sync.
 *   2. Client 1 goes offline.
 *   3. Client 0 deletes A.md, syncs (server marks document as deleted).
 *   4. Client 1 (offline) renames A.md -> B.md.
 *   5. Client 1 reconnects.
 *
 * The tricky part: Client 1's rename targets a document that was deleted on the
 * server between Client 1's disconnect and reconnect. The offline rename is a
 * sync-update with oldPath=A.md, relativePath=B.md. On reconnect, the offline
 * reconciliation detects B.md as a local file with a documentId pointing to a
 * deleted server document. The system must decide: honor the rename (creating a
 * new document at B.md) or propagate the delete.
 *
 * This test verifies that both clients converge regardless of which resolution
 * strategy the system uses, and that no data is silently lost without the other
 * client also seeing the same result.
 *
 * We also add a second file C.md that remains untouched to verify unrelated
 * documents are not affected by the conflict resolution.
 */

function verifyState(state: ClientState): void {
    // C.md must always survive (unrelated to the conflict)
    assert(
        state.files.has("C.md"),
        `Expected C.md to exist (untouched). ` +
            `Files: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.get("C.md") === "unrelated",
        `Expected C.md content to be "unrelated", got: "${state.files.get("C.md")}"`
    );

    // A.md should NOT exist (it was either renamed or deleted)
    assert(
        !state.files.has("A.md"),
        `Expected A.md to NOT exist. ` +
            `Files: ${Array.from(state.files.keys()).join(", ")}`
    );

    // Either B.md exists (rename won) or no extra files exist (delete won).
    // The key invariant is convergence, which assert-consistent already checks.
    // But let's also verify that the content is correct if B.md exists.
    if (state.files.has("B.md")) {
        const content = state.files.get("B.md") ?? "";
        assert(
            content === "original",
            `If B.md exists (rename won), it should have the original content. Got: "${content}"`
        );
    }
}

export const mcDeleteThenOfflineRenameTest: TestDefinition = {
    name: "MC: Delete Synced Then Offline Rename",
    description:
        "Client 0 creates A.md, both sync. Client 1 goes offline. Client 0 deletes " +
        "A.md and syncs. Client 1 (offline) renames A.md to B.md. Client 1 reconnects. " +
        "Both must converge. C.md (unrelated) must be unaffected.",
    clients: 2,
    steps: [
        // Phase 1: Client 0 creates A.md and C.md, both sync
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "create", client: 0, path: "C.md", content: "unrelated" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "A.md", content: "original" },
        { type: "assert-content", client: 1, path: "C.md", content: "unrelated" },

        // Phase 2: Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Phase 3: Client 0 deletes A.md and syncs
        { type: "delete", client: 0, path: "A.md" },
        { type: "sync", client: 0 },
        { type: "assert-not-exists", client: 0, path: "A.md" },

        // Phase 4: Client 1 (offline) renames A.md -> B.md
        { type: "rename", client: 1, oldPath: "A.md", newPath: "B.md" },

        // Phase 5: Client 1 reconnects
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both must converge — key assertions
        { type: "assert-consistent", verify: verifyState }
    ]
};
