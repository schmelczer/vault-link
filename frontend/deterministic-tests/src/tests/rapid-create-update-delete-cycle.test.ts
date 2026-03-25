import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * EDGE CASE: Rapid create-update-delete cycle tests coalescing correctness.
 *
 * When events arrive faster than the queue can process them, coalescing
 * determines the final action. This tests the full cycle:
 *
 * create + update = create (content read at sync time)
 * create + delete = noop
 *
 * So a create-update-delete sequence should coalesce to noop and never
 * reach the server at all.
 *
 * But then a new create follows:
 * noop + create = create
 *
 * The final file should be synced correctly.
 */
function verifyFinalState(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(state.files.has("cycle.md"), "Expected cycle.md to exist");
    const content = state.files.get("cycle.md") ?? "";
    assert(
        content === "final creation",
        `Expected "final creation", got: "${content}"`
    );
}

export const rapidCreateUpdateDeleteCycleTest: TestDefinition = {
    name: "Rapid Create-Update-Delete-Create Cycle",
    description:
        "Client 0 rapidly creates, updates, deletes, then re-creates a file. " +
        "The event coalescing should correctly reduce this to a single create " +
        "of the final content. Client 1 should see only the final file.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Pause server so all operations coalesce before being processed
        { type: "pause-server" },

        // Rapid cycle: create → update → delete
        {
            type: "create",
            client: 0,
            path: "cycle.md",
            content: "version 1"
        },
        {
            type: "update",
            client: 0,
            path: "cycle.md",
            content: "version 2"
        },
        { type: "delete", client: 0, path: "cycle.md" },

        // Re-create with final content
        {
            type: "create",
            client: 0,
            path: "cycle.md",
            content: "final creation"
        },

        // Resume server
        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
