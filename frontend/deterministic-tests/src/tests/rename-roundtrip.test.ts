import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyRoundtrip(state: ClientState): void {
    const files = Array.from(state.files.keys());
    assert(
        files.includes("A.md"),
        `Expected A.md to exist after round-trip rename, got: ${files.join(", ")}`
    );
    assert(
        !files.includes("B.md"),
        `B.md should not exist after round-trip rename, got: ${files.join(", ")}`
    );
    assert(
        state.files.get("A.md") === "original",
        `Expected A.md to have "original" content, got: "${state.files.get("A.md")}"`
    );
}

export const renameRoundtripTest: TestDefinition = {
    name: "Rename Round-Trip (A->B->A)",
    description:
        "Client 0 creates A.md and syncs. Then renames A.md to B.md and syncs. " +
        "Then renames B.md back to A.md and syncs. Both clients should end with " +
        "A.md at the original path with the original content. B.md should not exist. " +
        "Tests that the system correctly handles a rename that returns to the " +
        "original path, especially regarding document identity tracking.",
    clients: 2,
    steps: [
        // Setup: create and sync
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "A.md", content: "original" },

        // First rename: A.md -> B.md
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },
        { type: "sync" },
        { type: "barrier" },

        // Verify intermediate state: only B.md exists
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-exists", client: 0, path: "B.md" },
        { type: "assert-exists", client: 1, path: "B.md" },
        { type: "assert-content", client: 0, path: "B.md", content: "original" },
        { type: "assert-content", client: 1, path: "B.md", content: "original" },

        // Second rename: B.md -> A.md (back to original path)
        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },
        { type: "sync" },
        { type: "barrier" },

        // Final state: back to A.md with original content
        { type: "assert-not-exists", client: 0, path: "B.md" },
        { type: "assert-not-exists", client: 1, path: "B.md" },
        { type: "assert-consistent", verify: verifyRoundtrip }
    ]
};
