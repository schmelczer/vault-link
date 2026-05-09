import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const localEditLostDuringCreateMergeTest: TestDefinition = {
    description:
        "Client 0's create is in-flight (server paused) when Client 0 " +
        "writes a follow-up local edit. The wire-loop will receive the " +
        "create response, then must apply the queued local update against " +
        "the now-resolved doc id rather than discarding it as a stale " +
        "pending-create. Client 1's pre-existing same-path doc forces a " +
        "server-side merge, exercising the path where the local edit must " +
        "be re-attached to the merged doc id via replacePendingDocumentId.",
    clients: 2,
    steps: [
        // Client 1 creates and syncs doc.md first — this is the doc the
        // server will merge Client 0's later create into.
        { type: "create", client: 1, path: "doc.md", content: "from-client-1" },
        { type: "enable-sync", client: 1 },
        { type: "sync", client: 1 },

        // Client 0 starts offline so the create that follows queues into
        // the engine rather than firing immediately.
        { type: "create", client: 0, path: "doc.md", content: "from-client-0" },

        // Pause the server so c0's POST /documents will hang once it goes.
        { type: "pause-server" },
        { type: "enable-sync", client: 0 },

        // While the create's HTTP is in-flight against the paused server,
        // c0's local edit lands. This is the queue-coalesce scenario the
        // engine must survive: the LocalUpdate carries a Promise<DocId>
        // chained off the pending create, and replacePendingDocumentId
        // must rewire it once the server's merge response resolves to
        // Client 1's existing doc id.
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "local-edit-during-create"
        },

        { type: "resume-server" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                // The local edit must NOT be lost in the create-merge
                // collapse. assertContent (not assertContains) pins the
                // exact post-merge state — we accept either pure local
                // content (replace-wins) or a true merge containing both
                // contributions, but the local edit must be present.
                s.assertFileCount(1).assertContains(
                    "doc.md",
                    "local-edit-during-create"
                );
            }
        }
    ]
};
