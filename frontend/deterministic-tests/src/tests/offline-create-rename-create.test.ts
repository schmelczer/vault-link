import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyBothFilesExist(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();

    // B.md should exist with the original content (renamed from A.md)
    assert(
        state.files.has("B.md"),
        `B.md should exist (renamed from A.md). Files: ${files.join(", ")}`
    );
    const bContent = state.files.get("B.md") ?? "";
    assert(
        bContent === "first-content",
        `B.md should have "first-content" (original file), got: "${bContent}"`
    );

    // A.md should exist with the new content (recreated after rename)
    assert(
        state.files.has("A.md"),
        `A.md should exist (recreated after rename). Files: ${files.join(", ")}`
    );
    const aContent = state.files.get("A.md") ?? "";
    assert(
        aContent === "second-content",
        `A.md should have "second-content" (new file), got: "${aContent}"`
    );

    // Exactly 2 files
    assert(
        state.files.size === 2,
        `Expected 2 files, got ${state.files.size}: ${files.join(", ")}`
    );
}

export const offlineCreateRenameCreateTest: TestDefinition = {
    name: "Offline Create, Rename, Recreate Same Path",
    description:
        "Client 0 goes offline. Creates file A with content X, renames A to B, " +
        "then creates a new file A with content Y. When Client 0 reconnects, " +
        "Client 1 should see both A.md (content Y) and B.md (content X) -- " +
        "the rename and the new create are independent documents.",
    clients: 2,
    steps: [
        // Client 1 starts syncing immediately to receive updates
        { type: "enable-sync", client: 1 },

        // Client 0 is offline and performs create -> rename -> create
        { type: "create", client: 0, path: "A.md", content: "first-content" },
        {
            type: "rename",
            client: 0,
            oldPath: "A.md",
            newPath: "B.md"
        },
        { type: "create", client: 0, path: "A.md", content: "second-content" },

        // Client 0 enables sync -- offline reconciliation should detect
        // B.md and A.md as two separate new files
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both files should exist on both clients
        { type: "assert-exists", client: 0, path: "A.md" },
        { type: "assert-exists", client: 0, path: "B.md" },
        { type: "assert-exists", client: 1, path: "A.md" },
        { type: "assert-exists", client: 1, path: "B.md" },
        { type: "assert-consistent", verify: verifyBothFilesExist }
    ]
};
