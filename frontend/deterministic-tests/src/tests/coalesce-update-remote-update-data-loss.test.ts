import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const coalesceUpdateRemoteUpdateDataLossTest: TestDefinition = {
    description:
        "Divergent offline edits with text-merge expectation. Client 0's " +
        "remote update fully lands before Client 1 reconnects (`sync`-after " +
        "the c0 update enforces this), so Client 1's offline edit merges " +
        "against a server-known version, not a coalesced batch. Both " +
        "additions must survive in the final merged content. (Filename's " +
        "'coalesce' framing is aspirational — a true update-coalesce test " +
        "would skip the c0 sync and queue overlapping local + remote " +
        "updates against the same parent version.)",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "line 1\nline 2\nline 3"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "line 1\nline 2\nline 3\nclient 0 addition"
        },
        { type: "sync", client: 0 },

        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "client 1 addition\nline 1\nline 2\nline 3"
        },

        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertFileCount(1)
                    .assertContains(
                        "doc.md",
                        "client 0 addition",
                        "client 1 addition"
                    );
            }
        }
    ]
};
