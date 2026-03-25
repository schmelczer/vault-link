import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * Regression guard for the create+rename race from e2e log_4.log.
 *
 * In the e2e test, timing jitter caused the HTTP response to arrive
 * between the create and rename being coalesced by the sync queue,
 * orphaning the document. This is documented in CLAUDE.md as a known
 * limitation of concurrent creates at the same path.
 *
 * The deterministic test framework serializes steps, so the event
 * coalescing correctly handles the create+rename sequence here.
 * This test serves as a regression guard — if the coalescing logic
 * changes, this test will catch regressions.
 */
function verifyBothClientsHaveContent(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected exactly 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    const [content] = Array.from(state.files.values());
    assert(
        content === "the-content",
        `Expected file to have "the-content", got: "${content}"`
    );
}

export const createRenameResponseSkipsFileTest: TestDefinition = {
    name: "Create Then Immediate Rename — File Not Lost",
    description:
        "Client creates a file online then immediately renames it. " +
        "The create response arrives at the original path. " +
        "The other client must receive the file content.",
    clients: 2,
    steps: [
        // Both clients online
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 creates doc.md while online (HTTP request fires immediately)
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "the-content"
        },

        // Immediately rename — the create request is already in-flight
        {
            type: "rename",
            client: 0,
            oldPath: "doc.md",
            newPath: "renamed.md"
        },

        // Let everything sync
        { type: "sync" },
        { type: "sync" },
        { type: "barrier" },

        // Both clients must have the content (at whatever path)
        { type: "assert-consistent", verify: verifyBothClientsHaveContent }
    ]
};
