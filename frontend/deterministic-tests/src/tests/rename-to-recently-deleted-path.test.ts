import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyConvergence(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();

    // A.md should not exist (it was renamed away by Client 1)
    assert(
        !state.files.has("A.md"),
        `A.md should not exist after rename. Files: ${files.join(", ")}`
    );

    // B.md should exist — Client 1 renamed A.md to B.md, reclaiming the
    // path that Client 0 had just deleted. Content should be "content-a".
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist (renamed from A.md). Files: ${files.join(", ")}`
    );
    assert(
        state.files.get("B.md") === "content-a",
        `Expected B.md to have "content-a", got: "${state.files.get("B.md")}"`
    );

    assert(
        state.files.size === 1,
        `Expected exactly 1 file, got ${state.files.size}: ${files.join(", ")}`
    );
}

export const renameToRecentlyDeletedPathTest: TestDefinition = {
    name: "Rename to a Path That Was Recently Deleted",
    description:
        "Client 0 deletes B.md and syncs. Client 1 (offline) renames A.md " +
        "to B.md — claiming the path that was just vacated. When Client 1 " +
        "reconnects, the rename should succeed at B.md without collision.",
    clients: 2,
    steps: [
        // Setup: create both files
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 1 goes offline
        { type: "disable-sync", client: 1 },

        // Client 0 deletes B.md
        { type: "delete", client: 0, path: "B.md" },
        { type: "sync", client: 0 },

        // Client 1 (offline) renames A.md to B.md
        {
            type: "rename",
            client: 1,
            oldPath: "A.md",
            newPath: "B.md"
        },

        // Client 1 reconnects
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should converge: only B.md with content-a
        { type: "assert-consistent", verify: verifyConvergence }
    ]
};
