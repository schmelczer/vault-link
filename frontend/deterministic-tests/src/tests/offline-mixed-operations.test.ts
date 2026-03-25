import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyFinalState(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();

    // file1.md was deleted -- must not exist
    assert(
        !state.files.has("file1.md"),
        `file1.md should have been deleted but exists. Files: ${files.join(", ")}`
    );

    // file2.md was renamed to moved.md
    assert(
        !state.files.has("file2.md"),
        `file2.md should have been renamed but still exists. Files: ${files.join(", ")}`
    );
    assert(
        state.files.has("moved.md"),
        `moved.md should exist after rename. Files: ${files.join(", ")}`
    );
    const movedContent = state.files.get("moved.md") ?? "";
    assert(
        movedContent === "content-2",
        `moved.md should have original content "content-2", got: "${movedContent}"`
    );

    // file3.md was updated
    assert(
        state.files.has("file3.md"),
        `file3.md should exist. Files: ${files.join(", ")}`
    );
    const file3Content = state.files.get("file3.md") ?? "";
    assert(
        file3Content === "updated-content-3",
        `file3.md should have "updated-content-3", got: "${file3Content}"`
    );

    // Exactly 2 files should remain
    assert(
        state.files.size === 2,
        `Expected 2 files, got ${state.files.size}: ${files.join(", ")}`
    );
}

export const offlineMixedOperationsTest: TestDefinition = {
    name: "Offline Mixed Operations (Delete + Rename + Edit)",
    description:
        "Client 0 creates 3 files, syncs to both clients. Client 0 goes offline, " +
        "deletes file 1, renames file 2 to a new name, and edits file 3. " +
        "When Client 0 reconnects, all three operations should propagate to Client 1.",
    clients: 2,
    steps: [
        // Setup: Client 0 creates 3 files and syncs
        { type: "create", client: 0, path: "file1.md", content: "content-1" },
        { type: "create", client: 0, path: "file2.md", content: "content-2" },
        { type: "create", client: 0, path: "file3.md", content: "content-3" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Verify initial sync
        {
            type: "assert-content",
            client: 1,
            path: "file1.md",
            content: "content-1"
        },
        {
            type: "assert-content",
            client: 1,
            path: "file2.md",
            content: "content-2"
        },
        {
            type: "assert-content",
            client: 1,
            path: "file3.md",
            content: "content-3"
        },

        // Client 0 goes offline
        { type: "disable-sync", client: 0 },

        // Client 0 performs three different offline operations
        { type: "delete", client: 0, path: "file1.md" },
        {
            type: "rename",
            client: 0,
            oldPath: "file2.md",
            newPath: "moved.md"
        },
        {
            type: "update",
            client: 0,
            path: "file3.md",
            content: "updated-content-3"
        },

        // Client 0 reconnects
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // All operations should have propagated
        { type: "assert-not-exists", client: 1, path: "file1.md" },
        { type: "assert-not-exists", client: 1, path: "file2.md" },
        { type: "assert-exists", client: 1, path: "moved.md" },
        { type: "assert-exists", client: 1, path: "file3.md" },
        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
