import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * Invariant #7: parentVersionId must be consistent with cached content.
 *
 * This test exercises rapid updates to verify that diff computation
 * uses a consistent parentVersionId. Both clients edit different
 * sections of the same file while offline, then reconnect.
 */
function verifyBothEdits(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    const content = state.files.get("doc.md") ?? "";
    assert(
        content.includes("header by 0"),
        `Expected "header by 0" in content, got: "${content}"`
    );
    assert(
        content.includes("footer by 1"),
        `Expected "footer by 1" in content, got: "${content}"`
    );
}

export const concurrentUpdateDiffConsistencyTest: TestDefinition = {
    name: "Concurrent Updates Use Consistent Diff Base",
    description:
        "Rapid updates from both clients must produce correct merged " +
        "content, verifying parentVersionId consistency.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "header\nmiddle\nfooter"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both edit different sections offline
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "header by 0\nmiddle\nfooter"
        },
        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "header\nmiddle\nfooter by 1"
        },

        // Come online
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyBothEdits }
    ]
};
