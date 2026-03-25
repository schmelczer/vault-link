import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyAllEdits(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}`
    );
    assert(
        state.files.has("doc.md"),
        `Expected doc.md to exist`
    );
    const content = state.files.get("doc.md") ?? "";
    assert(
        content === "third edit",
        `Expected doc.md to contain "third edit", got: "${content}"`
    );
}

/**
 * Tests two consecutive offline→online cycles. Client 0 goes offline,
 * edits, comes online (first cycle). Then goes offline again, edits
 * more, comes online (second cycle). All edits should propagate to
 * Client 1.
 *
 * This exercises the runningReconciliation lifecycle: it must be
 * cleared after the first cycle so the second reconnect triggers a
 * fresh filesystem scan.
 */
export const doubleOfflineCycleTest: TestDefinition = {
    name: "Double Offline Cycle",
    description:
        "Client 0 goes offline, edits, comes online, syncs. Then goes " +
        "offline again, edits more, comes online again. Both offline edits " +
        "must propagate to Client 1. Tests that runningReconciliation is " +
        "properly cleared between cycles.",
    clients: 2,
    steps: [
        // Setup: create and sync
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "initial"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "doc.md",
            content: "initial"
        },

        // First offline cycle: edit
        { type: "disable-sync", client: 0 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "first edit"
        },

        // Come online, sync first edit
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "doc.md",
            content: "first edit"
        },

        // Second offline cycle: edit again
        { type: "disable-sync", client: 0 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "second edit"
        },

        // Come online, sync second edit
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "doc.md",
            content: "second edit"
        },

        // Third offline cycle: edit once more
        { type: "disable-sync", client: 0 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "third edit"
        },

        // Come online, sync third edit
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-consistent", verify: verifyAllEdits }
    ]
};
