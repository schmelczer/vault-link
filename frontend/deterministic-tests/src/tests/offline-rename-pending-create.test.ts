import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyRenamedFile(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();

    // original.md should not exist (it was renamed)
    assert(
        !state.files.has("original.md"),
        `original.md should not exist. Files: ${files.join(", ")}`
    );

    // renamed.md should exist with the content
    assert(
        state.files.has("renamed.md"),
        `Expected renamed.md to exist. Files: ${files.join(", ")}`
    );
    assert(
        state.files.get("renamed.md") === "pending content",
        `Expected "pending content", got: "${state.files.get("renamed.md")}"`
    );

    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${files.join(", ")}`
    );
}

export const offlineRenamePendingCreateTest: TestDefinition = {
    name: "Offline Rename of Pending Create Before Key Resolution",
    description:
        "Client 0 creates a file (pending, not yet synced). Sync is disabled " +
        "immediately. Client 0 renames the file locally. Sync is re-enabled. " +
        "The idempotency key system must handle the pending create at the new " +
        "path. The file should appear at the renamed path on both clients.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        // Create file, then immediately disable sync
        { type: "disable-sync", client: 0 },
        {
            type: "create",
            client: 0,
            path: "original.md",
            content: "pending content"
        },

        // Rename while still offline (pending create not yet confirmed)
        {
            type: "rename",
            client: 0,
            oldPath: "original.md",
            newPath: "renamed.md"
        },

        // Re-enable sync — triggers key resolution + offline reconciliation
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should have renamed.md with the content
        { type: "assert-not-exists", client: 0, path: "original.md" },
        { type: "assert-not-exists", client: 1, path: "original.md" },
        { type: "assert-consistent", verify: verifyRenamedFile }
    ]
};
