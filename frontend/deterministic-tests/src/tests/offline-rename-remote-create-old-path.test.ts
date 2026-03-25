import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyResult(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();

    // Y.md should exist — the renamed original document with
    // Client 1's updated content merged in.
    assert(
        state.files.has("Y.md"),
        `Expected Y.md to exist. Files: ${files.join(", ")}`
    );
    const content = state.files.get("Y.md") ?? "";
    assert(
        content.includes("updated-by-client-1"),
        `Expected Y.md to contain "updated-by-client-1", got: "${content}"`
    );

    assert(
        state.files.size === 1,
        `Expected exactly 1 file, got ${state.files.size}: ${files.join(", ")}`
    );
}

export const offlineRenameRemoteCreateOldPathTest: TestDefinition = {
    name: "Offline Rename + Remote Create at Old Path",
    description:
        "Client 0 renames X.md to Y.md while offline. Client 1 updates X.md " +
        "(same document). When Client 0 reconnects, the rename and update " +
        "should merge. Y.md should exist with Client 1's content.",
    clients: 2,
    steps: [
        // Setup: create X.md and sync
        { type: "create", client: 0, path: "X.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "X.md",
            content: "original"
        },

        // Client 0 goes offline and renames
        { type: "disable-sync", client: 0 },
        {
            type: "rename",
            client: 0,
            oldPath: "X.md",
            newPath: "Y.md"
        },

        // Client 1 updates the same document at X.md
        {
            type: "update",
            client: 1,
            path: "X.md",
            content: "updated-by-client-1"
        },
        { type: "sync", client: 1 },

        // Client 0 reconnects — must detect move AND merge with update
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should converge: Y.md with Client 1's content
        { type: "assert-consistent", verify: verifyResult }
    ]
};
