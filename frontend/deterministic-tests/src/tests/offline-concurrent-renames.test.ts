import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyConvergence(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();

    // The original file A.md should not exist (both clients renamed it away)
    assert(
        !state.files.has("A.md"),
        `A.md should not exist after both renames. Files: ${files.join(", ")}`
    );

    // Both clients renamed the same document. The server picks one rename
    // as the winner. Exactly one file should exist (the document at its
    // final path) since there was only one document to begin with.
    assert(
        state.files.size === 1,
        `Expected exactly 1 file (same document renamed), got ${state.files.size}: ${files.join(", ")}`
    );

    // The rename target should be B.md or C.md
    const hasB = state.files.has("B.md");
    const hasC = state.files.has("C.md");
    assert(
        hasB || hasC,
        `Expected B.md or C.md to exist. Files: ${files.join(", ")}`
    );

    // The content must be preserved regardless of which rename won
    const [content] = Array.from(state.files.values());
    assert(
        content === "shared-content",
        `Expected content "shared-content", got: "${content}"`
    );
}

export const offlineConcurrentRenamesTest: TestDefinition = {
    name: "Offline Concurrent Renames of Same File",
    description:
        "Client 0 creates A.md and syncs to both clients. Both clients go offline. " +
        "Client 0 renames A.md to B.md. Client 1 renames A.md to C.md. " +
        "Both reconnect. The system must converge -- both clients should " +
        "agree on the final state and the content must not be lost.",
    clients: 2,
    steps: [
        // Setup: create A.md and sync to both clients
        { type: "create", client: 0, path: "A.md", content: "shared-content" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "A.md",
            content: "shared-content"
        },

        // Both clients go offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Client 0 renames A.md -> B.md
        {
            type: "rename",
            client: 0,
            oldPath: "A.md",
            newPath: "B.md"
        },

        // Client 1 renames A.md -> C.md
        {
            type: "rename",
            client: 1,
            oldPath: "A.md",
            newPath: "C.md"
        },

        // Both reconnect
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // A.md must be gone from both
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },

        // Both must converge to the same state with content preserved
        { type: "assert-consistent", verify: verifyConvergence }
    ]
};
