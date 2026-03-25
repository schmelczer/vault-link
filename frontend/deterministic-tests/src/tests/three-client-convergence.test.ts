import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyAllContent(state: ClientState): void {
    // All three creates at the same path should merge into a single file
    assert(
        state.files.size === 1,
        `Expected 1 file after 3-way merge, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("A.md"),
        `Expected merged file at A.md, got: ${Array.from(state.files.keys()).join(", ")}`
    );

    const content = state.files.get("A.md") ?? "";
    assert(
        content.includes("from-zero"),
        `Expected merged content to include "from-zero", got: "${content}"`
    );
    assert(
        content.includes("from-one"),
        `Expected merged content to include "from-one", got: "${content}"`
    );
    assert(
        content.includes("from-two"),
        `Expected merged content to include "from-two", got: "${content}"`
    );
}

export const threeClientConvergenceTest: TestDefinition = {
    name: "Three Client Convergence",
    description:
        "Three clients all create the same file offline with different content. " +
        "When all three enable sync, the server must merge all three versions " +
        "and all clients must converge to the same state with all content preserved.",
    clients: 3,
    steps: [
        // All three create A.md offline with different content
        { type: "create", client: 0, path: "A.md", content: "from-zero" },
        { type: "create", client: 1, path: "A.md", content: "from-one" },
        { type: "create", client: 2, path: "A.md", content: "from-two" },

        // Enable sync on all three
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "enable-sync", client: 2 },
        { type: "sync" },
        { type: "barrier" },

        // All three must converge and all content must be preserved
        { type: "assert-consistent", verify: verifyAllContent }
    ]
};
