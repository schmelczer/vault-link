import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Events for a currently-processing document may be lost.
 *
 * Found by: sync-event-queue.ts analysis (agent #3)
 *
 * In sync-event-queue.ts, when processNext() starts executing an action
 * for a document key, it removes the key from documentStates (line 259)
 * and sets currentlyProcessing to the key (line 258).
 *
 * If a new event arrives for the SAME key while the executor is running:
 * 1. enqueue() coalesces into documentStates (line 50 or 47)
 * 2. Tries to add to processingOrder (line 71-76)
 * 3. The guard checks: currentlyProcessing !== key → FALSE
 * 4. So the key is NOT added to processingOrder
 * 5. When the executor finishes, processNext() picks the NEXT key
 * 6. The new event sits in documentStates but is never processed
 *
 * The system recovers via runFinalConsistencyCheck() which does a fresh
 * filesystem scan, but the immediate update is lost until then.
 *
 * This test creates a file, then updates it while the create is being
 * processed (using server pause to control timing). The update should
 * be reflected on both clients.
 */
function verifyUpdatedContent(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("file.md"), "Expected file.md to exist");
    const content = state.files.get("file.md") ?? "";
    assert(
        content === "updated during create",
        `Expected "updated during create", got: "${content}"`
    );
}

export const updateDuringCreateProcessingTest: TestDefinition = {
    name: "Update During Create Processing — Event Not Lost",
    description:
        "Client creates a file, then updates it while the create HTTP request " +
        "is in-flight (server paused). The update should eventually propagate " +
        "to the other client, not be silently lost in the queue.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Pause server so create stalls mid-processing
        { type: "pause-server" },

        // Create file (request stalls)
        {
            type: "create",
            client: 0,
            path: "file.md",
            content: "initial"
        },

        // Wait a bit for the create to enter the executor

        // Update while create is in-flight
        {
            type: "update",
            client: 0,
            path: "file.md",
            content: "updated during create"
        },

        // Resume server — create completes
        { type: "resume-server" },
        { type: "sync" },
        { type: "barrier" },

        // Updated content should be on both clients
        { type: "assert-consistent", verify: verifyUpdatedContent }
    ]
};
