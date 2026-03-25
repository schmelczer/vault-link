import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * Edge case: Both clients create files at DIFFERENT paths, then both rename
 * their respective files to the SAME target path.
 *
 * Timeline:
 *   1. Client 0 creates X.md, Client 1 creates Y.md (both offline).
 *   2. Both enable sync, converge (X.md and Y.md exist on both).
 *   3. Client 1 goes offline.
 *   4. Client 0 renames X.md -> Z.md, syncs.
 *   5. Client 1 (offline) renames Y.md -> Z.md.
 *   6. Client 1 reconnects.
 *
 * The tricky part: Both renames target Z.md. Client 0's rename completes first
 * on the server. When Client 1 reconnects and tries to rename Y.md -> Z.md,
 * the server already has a document at Z.md (formerly X.md). The system must
 * use path deconfliction (e.g., Z (1).md) to preserve both documents' content.
 *
 * This differs from the existing concurrent-rename-same-target test because
 * the files START at different paths (not A.md/B.md created by the same client)
 * and the creates themselves are concurrent, exercising the interaction between
 * concurrent create-merge and rename-deconfliction.
 */

function verifyBothContentsPreserved(state: ClientState): void {
    const allContent = Array.from(state.files.values()).join("\n");
    assert(
        allContent.includes("content-x"),
        `Expected "content-x" to be preserved somewhere. ` +
            `Files: ${JSON.stringify(Object.fromEntries(state.files))}`
    );
    assert(
        allContent.includes("content-y"),
        `Expected "content-y" to be preserved somewhere. ` +
            `Files: ${JSON.stringify(Object.fromEntries(state.files))}`
    );

    // Neither X.md nor Y.md should exist (both were renamed away)
    assert(
        !state.files.has("X.md"),
        `Expected X.md to not exist (was renamed). ` +
            `Files: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        !state.files.has("Y.md"),
        `Expected Y.md to not exist (was renamed). ` +
            `Files: ${Array.from(state.files.keys()).join(", ")}`
    );

    // At least one file should be at Z.md
    assert(
        state.files.has("Z.md"),
        `Expected Z.md to exist. ` +
            `Files: ${Array.from(state.files.keys()).join(", ")}`
    );

    // There must be exactly 2 files (both contents preserved, possibly deconflicted)
    assert(
        state.files.size === 2,
        `Expected exactly 2 files, got ${state.files.size}: ` +
            Array.from(state.files.keys()).join(", ")
    );
}

export const mcCrossCreateRenameSameTargetTest: TestDefinition = {
    name: "MC: Cross-Create then Rename to Same Target",
    description:
        "Client 0 creates X.md, Client 1 creates Y.md. Both sync. Client 0 renames " +
        "X.md -> Z.md. Client 1 (offline) renames Y.md -> Z.md. Both must converge " +
        "with both contents preserved via path deconfliction.",
    clients: 2,
    steps: [
        // Phase 1: Both create files offline at different paths
        { type: "create", client: 0, path: "X.md", content: "content-x" },
        { type: "create", client: 1, path: "Y.md", content: "content-y" },

        // Both enable sync — creates race to server
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Verify both files exist on both clients
        { type: "assert-exists", client: 0, path: "X.md" },
        { type: "assert-exists", client: 0, path: "Y.md" },
        { type: "assert-exists", client: 1, path: "X.md" },
        { type: "assert-exists", client: 1, path: "Y.md" },

        // Phase 2: Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Phase 3: Client 0 renames X.md -> Z.md and syncs
        { type: "rename", client: 0, oldPath: "X.md", newPath: "Z.md" },
        { type: "sync", client: 0 },

        // Phase 4: Client 1 (offline) renames Y.md -> Z.md
        { type: "rename", client: 1, oldPath: "Y.md", newPath: "Z.md" },

        // Phase 5: Client 1 reconnects
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both contents must be preserved, both clients consistent
        { type: "assert-consistent", verify: verifyBothContentsPreserved }
    ]
};
