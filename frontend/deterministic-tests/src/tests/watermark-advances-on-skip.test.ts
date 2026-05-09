import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const watermarkAdvancesOnSkipTest: TestDefinition = {
    description:
        "Probes that the watermark advances past 'skip' branches — events " +
        "the client receives but treats as already-applied (e.g. an " +
        "offline-create that the server merged into another doc). Both " +
        "clients create the same path offline and reconnect; one becomes " +
        "the canonical doc and the other's create is skipped via merge. " +
        "Then Client 1 disconnects, Client 0 issues a follow-up update, " +
        "and on Client 1's reconnect catch-up MUST deliver it. If the " +
        "skip branch failed to advance lastSeenUpdateId, catch-up either " +
        "wedges in re-replay (would time out) or misses the follow-up.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "create", client: 0, path: "doc.md", content: "from client 0" },
        { type: "create", client: 1, path: "doc.md", content: "from client 1" },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        // Now exercise the skip-then-receive path. Disconnect c1, have
        // c0 push a new update, reconnect c1 — c1's catch-up must
        // deliver the update past the skipped event.
        { type: "disable-sync", client: 1 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "post-skip update"
        },
        { type: "sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent(
                    "doc.md",
                    "post-skip update"
                );
            }
        }
    ]
};
