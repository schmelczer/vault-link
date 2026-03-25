import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyFinalState(state: ClientState): void {
    const files = Array.from(state.files.keys());
    // Client 0 updated both files, then deleted B.md.
    // Client 1 updated B.md while Client 0 was offline.
    //
    // After reconnect:
    // - A.md should have Client 0's update
    // - B.md: Client 0 deleted it (local intent), Client 1 updated it
    //   (remote update). The coalescing path determines which wins.
    //   Current behavior: delete wins (local-delete + remote-update
    //   coalesces differently depending on ordering).
    assert(
        state.files.has("A.md"),
        `Expected A.md to exist, got: ${files.join(", ")}`
    );
    const aContent = state.files.get("A.md") ?? "";
    assert(
        aContent === "A updated by client 0",
        `Expected A.md to have Client 0's update, got: "${aContent}"`
    );

    // B.md should be gone (Client 0 deleted it)
    assert(
        !state.files.has("B.md"),
        `Expected B.md to be deleted, got: ${files.join(", ")}`
    );
}

/**
 * Tests a complex offline scenario: Client 0 goes offline, updates
 * two files, then deletes one of them. Meanwhile Client 1 updates
 * the file that Client 0 will delete. When Client 0 comes online,
 * the reconciliation must handle:
 * 1. A.md: local update (straightforward)
 * 2. B.md: deleted locally + updated remotely (conflict)
 *
 * This exercises the offline reconciliation ordering:
 * updates are enqueued before deletes, and coalescing with
 * remote updates received during reconnect.
 */
export const offlineUpdateBothThenDeleteOneTest: TestDefinition = {
    name: "Offline Update Both Files Then Delete One",
    description:
        "Client 0 goes offline, updates A.md and B.md, then deletes B.md. " +
        "Client 1 updates B.md while Client 0 is offline. When Client 0 " +
        "reconnects, A.md should have the update and B.md should be " +
        "consistently resolved (delete wins).",
    clients: 2,
    steps: [
        // Setup: create two files
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "A original"
        },
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "B original"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-content",
            client: 1,
            path: "A.md",
            content: "A original"
        },
        {
            type: "assert-content",
            client: 1,
            path: "B.md",
            content: "B original"
        },

        // Client 0 goes offline
        { type: "disable-sync", client: 0 },

        // Client 0 updates both files
        {
            type: "update",
            client: 0,
            path: "A.md",
            content: "A updated by client 0"
        },
        {
            type: "update",
            client: 0,
            path: "B.md",
            content: "B updated by client 0"
        },

        // Client 0 deletes B.md
        { type: "delete", client: 0, path: "B.md" },

        // Meanwhile Client 1 updates B.md
        {
            type: "update",
            client: 1,
            path: "B.md",
            content: "B updated by client 1"
        },
        { type: "sync", client: 1 },

        // Client 0 comes online
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        { type: "assert-consistent", verify: verifyFinalState }
    ]
};
