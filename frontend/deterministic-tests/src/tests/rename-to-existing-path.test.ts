import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyFinalState(state: ClientState): void {
    // A.md should not exist (it was renamed)
    assert(!state.files.has("A.md"), "A.md should not exist after rename");
    // B.md should exist with the alpha content (from the renamed A.md)
    assert(state.files.has("B.md"), "B.md should exist");
    assert(
        state.files.get("B.md") === "alpha",
        `B.md should have "alpha" content, got: "${state.files.get("B.md")}"`
    );
    // The original B.md content ("beta") should be overwritten — only the
    // renamed content should survive. Verify no other files contain "beta".
    const allContent = Array.from(state.files.values()).join("\n");
    assert(
        !allContent.includes("beta"),
        `Expected "beta" to be gone after overwrite, but found it in: ${JSON.stringify(Object.fromEntries(state.files))}`
    );
}

export const renameToExistingPathTest: TestDefinition = {
    name: "Rename to Existing Path",
    description:
        "Client 0 has A.md and B.md. Client 0 renames A.md to B.md (overwriting B.md). " +
        "Both clients should converge: A.md gone, B.md has A.md's content.",
    clients: 2,
    steps: [
        // Setup: create two files and sync
        { type: "create", client: 0, path: "A.md", content: "alpha" },
        { type: "create", client: 0, path: "B.md", content: "beta" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 renames A.md to B.md (overwrites B.md)
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "sync" },
        { type: "barrier" },

        // Both should converge
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
