import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * EDGE CASE: New file created during offline reconciliation.
 *
 * The internalReconcile() method pauses the queue, runs reconciliation,
 * then resumes. But file changes can happen DURING reconciliation:
 *
 * 1. Client goes offline, creates files A.md and B.md
 * 2. Client reconnects → internalReconcile starts
 * 3. reconcileWithDisk scans filesystem, finds A.md and B.md
 * 4. Events are enqueued for both files
 * 5. Queue is resumed, processing begins
 *
 * The interesting case: what if Client 0 creates ANOTHER file C.md
 * right after reconnect but before reconciliation finishes? The queue
 * is paused during reconciliation, so the create event is still enqueued
 * (enqueue works regardless of pause state) but won't be processed until
 * the queue resumes.
 *
 * This test verifies that all three files eventually sync correctly.
 */
function verifyAllFiles(state: ClientState): void {
    assert(
        state.files.size === 3,
        `Expected 3 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("A.md") &&
            state.files.has("B.md") &&
            state.files.has("C.md"),
        `Expected A.md, B.md, C.md. Got: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.get("A.md") === "offline A",
        `Expected A.md = "offline A", got: "${state.files.get("A.md")}"`
    );
    assert(
        state.files.get("B.md") === "offline B",
        `Expected B.md = "offline B", got: "${state.files.get("B.md")}"`
    );
    assert(
        state.files.get("C.md") === "post-reconnect C",
        `Expected C.md = "post-reconnect C", got: "${state.files.get("C.md")}"`
    );
}

export const createDuringReconciliationTest: TestDefinition = {
    name: "File Created Right After Reconnect (During Reconciliation)",
    description:
        "Client creates files while offline, reconnects, then immediately " +
        "creates another file. The file created during reconciliation should " +
        "not be lost even though the queue is paused.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline, creates two files
        { type: "disable-sync", client: 0 },
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "offline A"
        },
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "offline B"
        },

        // Client 0 reconnects
        { type: "enable-sync", client: 0 },

        // Immediately create another file (before sync finishes)
        {
            type: "create",
            client: 0,
            path: "C.md",
            content: "post-reconnect C"
        },

        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyAllFiles }
    ]
};
