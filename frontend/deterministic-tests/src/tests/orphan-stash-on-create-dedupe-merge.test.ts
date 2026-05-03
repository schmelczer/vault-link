import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const orphanStashOnCreateDedupeMergeTest: TestDefinition = {
    description:
        "When the server's create endpoint dedupe-merges a client's local " +
        "create into an existing fresh remote doc that the client has " +
        "already tracked at a `conflict-<uuid>-` stash (because the " +
        "remote create's broadcast displaced its content there), " +
        "`processCreate`'s response handler relocates the doc's record " +
        "onto the canonical path via `setDocument` but the stash file on " +
        "disk is left behind — outliving its tracking record and " +
        "diverging from every other client. Reproducing the merge half " +
        "of the dedupe is delicate: the server's merge gate requires the " +
        "POST's `last_seen_vault_update_id` to be *strictly less than* " +
        "the existing doc's `creation_vault_update_id`. A normal sync " +
        "advances the watermark contiguously, so on the canonical " +
        "create-vs-create race the watermark would already include the " +
        "remote doc's create when the local POST ships, the merge gate " +
        "fails, and the server deconflicts to `(1)`. This test pokes a " +
        "permanent gap into the watermark via the catch-up replay's " +
        "latest-only semantics: a tempdoc created and deleted while " +
        "Client 0 is offline lives in catch-up only as the delete event, " +
        "which the client processes (advancing the watermark to the " +
        "delete) without ever filling the create's update id — so the " +
        "watermark's contiguous-prefix min stays below the next doc's " +
        "creation. With that gap in place, Client 0's post-displacement " +
        "POST satisfies the server's merge gate, the server returns the " +
        "existing docId, and `processCreate` walks straight into the " +
        "orphan-stash bug. Pre-fix: `Files from agent-0 missing in " +
        "agent-1` (the `conflict-<uuid>-` stash). Post-fix: cleaned up.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        // Client 0 goes offline. Its watermark is saved at v=0.
        { type: "disable-sync", client: 0 },

        // Tempdoc that lives only as a delete in Client 0's catch-up
        // (the create at v=1 is collapsed away by latest-only replay).
        // The processed delete advances the watermark to v=2 but leaves
        // v=1 unfilled, parking the contiguous-prefix min at 0.
        { type: "create", client: 1, path: "tempdoc.md", content: "x\n" },
        { type: "sync", client: 1 },
        { type: "delete", client: 1, path: "tempdoc.md" },
        { type: "sync", client: 1 },

        // The doc whose dedupe-merge we want to trigger — fresh
        // (creation == latest), mergeable text. Its creation v=3 is
        // strictly greater than Client 0's stuck min of 0, so the
        // server's merge gate will fire.
        { type: "create", client: 1, path: "file.md", content: "from-1\n" },
        { type: "sync", client: 1 },

        // Re-arm the WS pause for the new socket Client 0 is about to
        // create on enable-sync, so the catch-up broadcast is buffered
        // until we explicitly release it. Without sticky pause across
        // factory `constructorFn` calls this would silently miss the
        // catch-up.
        { type: "pause-websocket", client: 0 },
        { type: "enable-sync", client: 0 },

        // Server pause arrives before the buffered catch-up is released
        // so the resume below parks Client 0's drain on the GET for
        // file.md's content (the only fetching event in the catch-up;
        // the tempdoc delete needs no fetch and runs through quickly,
        // leaving the watermark gap intact).
        { type: "pause-server" },
        { type: "resume-websocket", client: 0 },

        // Yield so the drain has time to traverse the WS handler →
        // listener → enqueue → drain → processRemoteCreateForNewDocument
        // → fetch hops before the local create runs.
        { type: "sleep", ms: 100 },

        // Client 0 creates file.md locally while the GET is parked. The
        // file occupies the canonical slot, so when the GET returns the
        // remote create displaces D's bytes to `conflict-<uuid>-file.md`
        // and tracks D there with `intendedPath=file.md`. The
        // LocalCreate enqueues behind the in-flight RemoteChange.
        { type: "create", client: 0, path: "file.md", content: "from-0\n" },

        { type: "resume-server" },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1);
                s.assertFileExists("file.md");
            }
        }
    ]
};
