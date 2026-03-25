import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyMergedEdits(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}`
    );
    assert(
        state.files.has("doc.md"),
        `Expected doc.md to exist`
    );
    const content = state.files.get("doc.md") ?? "";

    // Both edits should be present in the merged result.
    // Client 0 added "alpha addition" and Client 1 added "beta addition".
    // The shared heading and footer should be preserved.
    assert(
        content.includes("# Title"),
        `Expected "# Title" to be preserved, got: "${content}"`
    );
    assert(
        content.includes("alpha addition"),
        `Expected Client 0's edit "alpha addition" to be present, got: "${content}"`
    );
    assert(
        content.includes("beta addition"),
        `Expected Client 1's edit "beta addition" to be present, got: "${content}"`
    );
    assert(
        content.includes("footer"),
        `Expected "footer" to be preserved, got: "${content}"`
    );
}

export const overlappingEditsSameSectionTest: TestDefinition = {
    name: "Overlapping Edits in Same Section",
    description:
        "Both clients edit the same document by adding content to different " +
        "parts of the same section. Client 0 adds a line after the heading, " +
        "Client 1 adds a line before the footer. The 3-way merge should " +
        "preserve both edits without data loss.",
    clients: 2,
    steps: [
        // Setup: create a multi-line document
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "# Title\n\nfooter"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients go offline and edit the same document
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        // Client 0: add line after heading
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "# Title\nalpha addition\n\nfooter"
        },

        // Client 1: add line before footer
        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "# Title\n\nbeta addition\nfooter"
        },

        // Both reconnect
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both edits should be merged
        { type: "assert-consistent", verify: verifyMergedEdits }
    ]
};
