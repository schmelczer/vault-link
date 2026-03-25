import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyNestedPath(state: ClientState): void {
    const files = Array.from(state.files.keys());
    assert(
        !files.includes("a.md"),
        `a.md should not exist after rename to nested path, got: ${files.join(", ")}`
    );
    assert(
        files.includes("folder/subfolder/a.md"),
        `Expected folder/subfolder/a.md to exist, got: ${files.join(", ")}`
    );
    assert(
        state.files.get("folder/subfolder/a.md") === "nested content",
        `Expected nested file to have "nested content", got: "${state.files.get("folder/subfolder/a.md")}"`
    );
}

export const renameNestedPathTest: TestDefinition = {
    name: "Rename to Deeply Nested Path",
    description:
        "Client 0 creates a.md at the root, then renames it to folder/subfolder/a.md " +
        "while offline. When Client 0 reconnects, the file should appear at the " +
        "nested path on both clients. Tests that the system handles directory " +
        "creation for deeply nested rename targets.",
    clients: 2,
    steps: [
        // Setup: create file at root and sync
        { type: "create", client: 0, path: "a.md", content: "nested content" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "a.md", content: "nested content" },

        // Client 0 goes offline and renames to nested path
        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "a.md", newPath: "folder/subfolder/a.md" },

        // Client 0 reconnects
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Original path gone, nested path exists
        { type: "assert-not-exists", client: 0, path: "a.md" },
        { type: "assert-not-exists", client: 1, path: "a.md" },
        { type: "assert-exists", client: 0, path: "folder/subfolder/a.md" },
        { type: "assert-exists", client: 1, path: "folder/subfolder/a.md" },
        { type: "assert-consistent", verify: verifyNestedPath }
    ]
};
