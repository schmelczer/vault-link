import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: create → rename → create at same path while offline.
 *
 * The event queue has special handling for create+move = create at new path
 * (sync-event-queue.ts line 56-68), which migrates the key from the old
 * path to the new path. This frees the old path key for a subsequent create.
 *
 * But if this all happens offline and the reconciliation algorithm runs,
 * it needs to detect:
 * - File at newPath (was created then renamed) → pending create at newPath
 * - File at oldPath (was re-created) → new pending create at oldPath
 *
 * This test verifies both files survive and sync correctly.
 */
function verifyBothFiles(state: ClientState): void {
    assert(
        state.files.size === 2,
        `Expected 2 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("A.md"),
        `Expected A.md to exist, files: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist, files: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.get("A.md") === "second file at A",
        `Expected A.md = "second file at A", got: "${state.files.get("A.md")}"`
    );
    assert(
        state.files.get("B.md") === "first file moved to B",
        `Expected B.md = "first file moved to B", got: "${state.files.get("B.md")}"`
    );
}

export const createRenameCreateSamePathOfflineTest: TestDefinition = {
    name: "Create → Rename → Create at Same Path (Offline)",
    description:
        "While offline, Client 0 creates A.md, renames it to B.md, then " +
        "creates a new A.md. Both files should sync to Client 1.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline
        { type: "disable-sync", client: 0 },

        // Create A.md
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "first file moved to B"
        },

        // Rename A.md → B.md
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },

        // Create a new A.md
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "second file at A"
        },

        // Reconnect
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both files should exist on both clients
        { type: "assert-consistent", verify: verifyBothFiles }
    ]
};
