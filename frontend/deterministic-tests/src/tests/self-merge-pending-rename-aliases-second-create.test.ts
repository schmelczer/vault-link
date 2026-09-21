import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const selfMergePendingRenameAliasesSecondCreateTest: TestDefinition = {
    description:
        "Single client makes two distinct creates that briefly share a path. " +
        "Client 0 POSTs the first create at primary.md while the server is " +
        "paused. While that POST is in flight: a second create is queued at " +
        "staging.md, primary.md is renamed to moved.md (rewriting the in- " +
        "flight create's event.path to moved.md and pushing a rename " +
        "LocalUpdate at the queue tail), and staging.md is renamed onto the " +
        "now-vacated primary.md slot (rewriting the second create's " +
        "event.path to primary.md and pushing another rename LocalUpdate). " +
        "Client 0's WS is paused throughout, so its watermark stays at 0. " +
        "On resume the first POST commits Doc-X at primary.md (creation_vuid " +
        "= N). The drain then processes the second LocalCreate (POST " +
        "relativePath=primary.md, last_seen=0); the server's path-based " +
        "dedup sees N > 0 and merges the second create into Doc-X " +
        "(MergingUpdate). The buggy behaviour: processCreate's resolveCreate " +
        "calls upsertRecord with localPath=primary.md, but the existing " +
        "record (from the first create) already holds localPath=moved.md, " +
        "and upsertRecord's `existing.localPath !== undefined` guard " +
        "silently drops the new claim. The file at primary.md is left " +
        "orphaned: tracked by no record, never broadcast, never deleted. " +
        "After the user's renames the expected user-visible state is two " +
        "distinct files at moved.md and primary.md — both clients must " +
        "converge to that.",
    clients: 2,
    steps: [
        // Both clients online so the WS connection is established before
        // the test starts pausing things.
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        // Delay socket notifications while client 0 continues local work.
        // HTTP catchup must preserve the two generations at the reused path.
        { type: "pause-websocket", client: 0 },

        // Client 1 commits a doc to push the server's vuid above 0.
        // Without this filler, Doc-X's create vuid could be 1 and
        // client 0's last_seen.add(1) would advance min to 1, killing
        // the watermark gap that triggers the merge.
        {
            type: "create",
            client: 1,
            path: "filler.md",
            content: "filler-content "
        },
        { type: "sync", client: 1 },

        // Pause the server so client 0's first create POST hangs in
        // flight, giving us a deterministic window in which to enqueue
        // the second create and the renames.
        { type: "pause-server" },

        // First create — Doc-X. The wire-loop drains it, captures
        // requestPath = event.path = "primary.md", reads the bytes,
        // sends the POST, and stalls on the response.
        {
            type: "create",
            client: 0,
            path: "primary.md",
            content: "primary content "
        },

        // Make sure the POST is actually on the wire with
        // relativePath="primary.md" before we rewrite event.path.
        // Without this delay the rename can win the race, the POST
        // goes out with relativePath="moved.md", and the server-side
        // path-collision merge never fires.
        { type: "sleep", ms: 100 },

        // Second create at a staging path. The wire-loop is still
        // blocked on Doc-X's POST, so this LocalCreate just queues at
        // index 1.
        {
            type: "create",
            client: 0,
            path: "staging.md",
            content: "secondary content "
        },

        // Rename Doc-X's path. enqueue's pending-create branch
        // rewrites Doc-X's event.path in place (moved.md) and pushes
        // a LocalUpdate(rename, originalPath=moved.md) at the END of
        // the queue. Note the ordering: this LocalUpdate is enqueued
        // AFTER the staging LocalCreate above. That ordering is
        // load-bearing — it is what makes the second create's POST
        // drain (and trigger the server-side merge) before Doc-X's
        // rename PUT moves the doc away from primary.md on the
        // server.
        {
            type: "rename",
            client: 0,
            oldPath: "primary.md",
            newPath: "moved.md"
        },

        // Rename the staging file onto Doc-X's now-vacated primary.md
        // slot. enqueue rewrites the staging LocalCreate's event.path
        // to primary.md and pushes a LocalUpdate(rename,
        // originalPath=primary.md) at the queue tail. After this the
        // disk has: moved.md = Doc-X's bytes, primary.md = Doc-Y's
        // bytes.
        {
            type: "rename",
            client: 0,
            oldPath: "staging.md",
            newPath: "primary.md"
        },

        // Let everything fly: server processes the queued POSTs;
        // client 0 catches up on broadcasts.
        { type: "resume-server" },
        { type: "resume-websocket", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                // The user did two distinct creates (Doc-X and Doc-Y);
                // both contents must survive on both clients.
                state.assertFileCount(3);
                state.assertFileExists("filler.md");
                state.assertFileExists("moved.md");
                state.assertFileExists("primary.md");

                // After the renames the user expects:
                //   - moved.md  = the file that was originally created
                //                 at primary.md (Doc-X's content).
                //   - primary.md = the file that was originally created
                //                  at staging.md (Doc-Y's content).
                state.assertContains("moved.md", "primary content");
                state.assertContains("primary.md", "secondary content");

                // No content cross-contamination: each contribution
                // should land in exactly one of the user-visible
                // files. Under the bug, the orphan at primary.md
                // carries Doc-X's content (because Doc-Y's PUT was
                // aliased onto Doc-X's record and read Doc-X's bytes
                // from moved.md), so this catches the leak too.
                state.assertContentInAtMostOneFile("primary content");
                state.assertContentInAtMostOneFile("secondary content");
            }
        }
    ]
};
