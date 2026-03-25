import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyBothFilesPreserved(state: ClientState): void {
    assert(
        state.files.size === 2,
        `Expected 2 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("A.md"),
        `Expected A.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );

    const contentA = state.files.get("A.md") ?? "";
    const contentB = state.files.get("B.md") ?? "";
    assert(
        contentA === "identical content here",
        `A.md has wrong content: "${contentA}"`
    );
    assert(
        contentB === "identical content here",
        `B.md has wrong content: "${contentB}"`
    );
}

export const sequentialCreateDuplicateContentTest: TestDefinition = {
    name: "Sequential Creates With Identical Content Preserved",
    description:
        "Client 0 creates A.md and syncs it. Then Client 0 creates B.md with " +
        "the exact same content as A.md and syncs again. Both files must be " +
        "preserved as separate documents — the duplicate content detection " +
        "must not collapse them into one file or delete B.md.",
    clients: 2,
    steps: [
        // Create A.md and sync it fully
        { type: "create", client: 0, path: "A.md", content: "identical content here" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Verify A.md arrived on client 1
        {
            type: "assert-content",
            client: 1,
            path: "A.md",
            content: "identical content here"
        },

        // Now create B.md with identical content on client 0
        { type: "create", client: 0, path: "B.md", content: "identical content here" },
        { type: "sync" },
        { type: "barrier" },

        // Both files must exist on both clients with correct content.
        // This catches bugs where duplicate detection (content hash matching
        // during offline reconciliation) accidentally treats B.md as a
        // "move" of A.md, or where the server merges B.md into A.md's
        // document because of identical content at a different path.
        { type: "assert-consistent", verify: verifyBothFilesPreserved }
    ]
};
