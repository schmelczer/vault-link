import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const watermarkGapRemoteUpdateNotRecordedTest: TestDefinition = {
    description:
        "Probes that the watermark records every observed remote update, " +
        "even when two arrive in close succession with intervening " +
        "vault_update_ids the client also sees. Client 0 sends two " +
        "updates with `sync` between them so they hit the wire as two " +
        "distinct broadcasts. Client 1 processes both. Then Client 1 " +
        "disconnects, Client 0 issues a third update while Client 1 is " +
        "offline, and on reconnect Client 1's catch-up MUST deliver the " +
        "third update — if the gap-update was not recorded into " +
        "lastSeenUpdateId, catch-up requests events newer than the " +
        "incorrectly-advanced watermark and silently misses the third.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "update", client: 0, path: "doc.md", content: "update 1" },
        { type: "sync", client: 0 },
        { type: "update", client: 0, path: "doc.md", content: "update 2" },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        // Issued while c1 is offline. Catch-up MUST deliver this on
        // reconnect; a too-new watermark would silently skip it.
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "offline-period update"
        },
        { type: "sync", client: 0 },

        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent(
                    "doc.md",
                    "offline-period update"
                );
            }
        }
    ]
};
