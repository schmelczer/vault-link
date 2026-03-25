import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyBothFilesExist(state: ClientState): void {
    assert(
        state.files.size === 2,
        `Expected 2 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(state.files.has("original.md"), "Expected original.md to exist");
    assert(state.files.has("copy.md"), "Expected copy.md to exist");
    assert(
        state.files.get("original.md") === "same content",
        `original.md has wrong content: "${state.files.get("original.md")}"`
    );
    assert(
        state.files.get("copy.md") === "same content",
        `copy.md has wrong content: "${state.files.get("copy.md")}"`
    );
}

export const duplicateContentFilesTest: TestDefinition = {
    name: "Duplicate Content Files Preserved",
    description:
        "Client 0 creates two files with identical content. Both should sync " +
        "to Client 1 without the duplicate detection deleting one of them.",
    clients: 2,
    steps: [
        // Create two files with identical content while offline
        { type: "create", client: 0, path: "original.md", content: "same content" },
        { type: "create", client: 0, path: "copy.md", content: "same content" },

        // Enable sync
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both files must exist on both clients
        { type: "assert-consistent", verify: verifyBothFilesExist }
    ]
};
