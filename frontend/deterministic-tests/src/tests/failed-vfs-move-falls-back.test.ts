import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * Tests rename-overwrite behavior: when file A is renamed to file B's
 * path (overwriting B), both clients should converge on a single file
 * at the target path with A's content.
 */
function verifyOneFile(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${[...state.files.keys()].join(", ")}`
    );
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist, got: ${[...state.files.keys()].join(", ")}`
    );
    assert(
        state.files.get("B.md") === "content A",
        `Expected B.md to have A's content, got: "${state.files.get("B.md")}"`
    );
}

export const failedVfsMoveFallsBackTest: TestDefinition = {
    name: "Rename Overwrite — A.md Renamed to Occupied B.md",
    description:
        "File A is renamed to B's path (overwriting B). Both clients " +
        "should converge on a single file at B.md with A's content.",
    clients: 2,
    steps: [
        // Setup: create two files
        { type: "create", client: 0, path: "A.md", content: "content A" },
        { type: "create", client: 0, path: "B.md", content: "content B" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 renames A.md to B.md (overwrite)
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should have only B.md
        { type: "assert-consistent", verify: verifyOneFile }
    ]
};
