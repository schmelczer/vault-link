import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyMergedContent(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("A.md"), "Expected A.md to exist");
    const content = state.files.get("A.md") ?? "";
    assert(
        content.includes("from-zero") && content.includes("from-one"),
        `Expected A.md to contain both "from-zero" and "from-one", got: "${content}"`
    );
}

function verifyEmpty(state: ClientState): void {
    assert(
        state.files.size === 0,
        `Expected 0 files after deletion, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
}

export const createMergeDeleteTest: TestDefinition = {
    name: "Concurrent Create, Merge, Then Delete",
    description:
        "Two clients simultaneously create A.md with different content. " +
        "The server merges them and both converge. Then Client 0 deletes A.md. " +
        "Both clients should converge on an empty state.",
    clients: 2,
    steps: [
        // Both clients create A.md offline with different content
        { type: "create", client: 0, path: "A.md", content: "from-zero" },
        { type: "create", client: 1, path: "A.md", content: "from-one" },

        // Enable sync — both creates race to the server
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Phase 1: verify merge happened correctly
        { type: "assert-consistent", verify: verifyMergedContent },

        // Phase 2: Client 0 deletes the merged file
        { type: "delete", client: 0, path: "A.md" },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should have no files
        { type: "assert-not-exists", client: 0, path: "A.md" },
        { type: "assert-not-exists", client: 1, path: "A.md" },
        { type: "assert-consistent", verify: verifyEmpty }
    ]
};
