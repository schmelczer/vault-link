import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyEmptyFile(state: ClientState): void {
    assert(state.files.has("empty.md"), "Expected empty.md to exist");
    assert(
        state.files.get("empty.md") === "",
        `Expected empty.md to be empty, got: "${state.files.get("empty.md")}"`
    );
}

export const emptyFileSyncTest: TestDefinition = {
    name: "Empty File Sync",
    description:
        "Client 0 creates an empty file. It should sync to Client 1 as empty. " +
        "Then Client 0 adds content. The update should propagate correctly.",
    clients: 2,
    steps: [
        // Create empty file
        { type: "create", client: 0, path: "empty.md", content: "" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Empty file should sync
        { type: "assert-consistent", verify: verifyEmptyFile },

        // Now add content
        { type: "update", client: 0, path: "empty.md", content: "no longer empty" },
        { type: "sync" },
        { type: "barrier" },

        // Updated content should propagate
        {
            type: "assert-content",
            client: 0,
            path: "empty.md",
            content: "no longer empty"
        },
        {
            type: "assert-content",
            client: 1,
            path: "empty.md",
            content: "no longer empty"
        },
        { type: "assert-consistent" }
    ]
};
