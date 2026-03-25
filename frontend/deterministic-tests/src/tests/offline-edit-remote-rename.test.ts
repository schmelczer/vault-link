import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyEditPreservedAtNewPath(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();

    // A.md should not exist (it was renamed to B.md)
    assert(
        !state.files.has("A.md"),
        `A.md should not exist after rename. Files: ${files.join(", ")}`
    );

    // B.md should exist with Client 0's edit merged in
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist. Files: ${files.join(", ")}`
    );

    const content = state.files.get("B.md") ?? "";
    assert(
        content.includes("edited by client 0"),
        `Expected B.md to contain Client 0's edit "edited by client 0", got: "${content}"`
    );

    assert(
        state.files.size === 1,
        `Expected exactly 1 file, got ${state.files.size}: ${files.join(", ")}`
    );
}

export const offlineEditRemoteRenameTest: TestDefinition = {
    name: "Offline Edit + Remote Rename",
    description:
        "Client 0 goes offline and edits A.md. Meanwhile Client 1 renames " +
        "A.md to B.md. When Client 0 reconnects, its edit should be applied " +
        "to B.md (the renamed path). The edit must not be lost and A.md must " +
        "not exist.",
    clients: 2,
    steps: [
        // Setup: create and sync
        { type: "create", client: 0, path: "A.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "A.md",
            content: "original"
        },

        // Client 0 goes offline and edits
        { type: "disable-sync", client: 0 },
        {
            type: "update",
            client: 0,
            path: "A.md",
            content: "edited by client 0"
        },

        // Client 1 renames A.md -> B.md while Client 0 is offline
        {
            type: "rename",
            client: 1,
            oldPath: "A.md",
            newPath: "B.md"
        },
        { type: "sync", client: 1 },

        // Client 0 reconnects — edit must be preserved at new path
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-consistent", verify: verifyEditPreservedAtNewPath }
    ]
};
