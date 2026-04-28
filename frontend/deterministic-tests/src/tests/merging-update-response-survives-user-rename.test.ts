import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const mergingUpdateResponseSurvivesUserRenameTest: TestDefinition = {
    description:
        "Client 1 sends a content update with a stale `parent_version_id` " +
        "(its WebSocket is paused, so it hasn't seen Client 0's intervening " +
        "edit). The server merges and replies with `MergingUpdate` carrying " +
        "the merged text. Before the response lands, the user renames the " +
        "doc on Client 1, vacating the disk path the in-flight " +
        "`processLocalUpdate` captured. Pre-fix: " +
        "`handleMaybeMergingResponse`'s `operations.write(diskPath, …)` " +
        "hits the `we wont recreate it` early-return inside `write`, " +
        "silently dropping the server-merged content — Client 0's edit is " +
        "lost on Client 1's disk, and Client 1's next local-update PUT " +
        "(rebased on the now-untracked merged version) deletes Client 0's " +
        "edit on the server too. Post-fix: the response is written to the " +
        "doc's current tracked disk path, preserving both edits.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "create", client: 0, path: "doc.md", content: "0\n" },
        { type: "barrier" },

        // Stop Client 1 from seeing Client 0's next edit, so its next
        // outbound PUT carries a stale `parent_version_id` and the server
        // is forced to merge.
        { type: "pause-websocket", client: 1 },

        // Server now holds v_b = "0\nA\n". Client 1's tracked parent
        // version stays at v_a = "0\n".
        { type: "update", client: 0, path: "doc.md", content: "0\nA\n" },
        { type: "sync", client: 0 },

        // Pause the server. Subsequent HTTP PUTs from Client 1 buffer at
        // the OS layer until resume. This guarantees the merge response
        // for Client 1's update is still in flight when the rename below
        // mutates `queue.documents`.
        { type: "pause-server" },

        // Client 1 edits doc.md with "B". The drain pops the LocalUpdate,
        // captures `diskPath = "doc.md"`, reads the file, and sends the
        // HTTP PUT — which buffers because the server is SIGSTOPped.
        { type: "update", client: 1, path: "doc.md", content: "0\nB\n" },

        // User renames the file while the previous PUT is still in flight.
        // `queue.enqueue`'s rename branch updates `documents` to point at
        // `renamed.md` synchronously, but `processLocalUpdate`'s captured
        // `diskPath` ("doc.md") is a local — it can't be retargeted.
        { type: "rename", client: 1, oldPath: "doc.md", newPath: "renamed.md" },

        // Resume the server. It reconciles parent=v_a, latest=v_b,
        // new="0\nB\n" → v_c with both edits, replies `MergingUpdate`.
        // Pre-fix: write("doc.md", …) sees no file at that path
        // (renamed.md now holds the data) and bails out without ever
        // writing the merged bytes. Post-fix: the merged bytes land at
        // the tracked path (renamed.md).
        { type: "resume-server" },
        { type: "resume-websocket", client: 1 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(1);
                state.assertFileExists("renamed.md");
                state.assertFileNotExists("doc.md");
                // Both edits survive: Client 0's "A" and Client 1's "B".
                // The reconcile may interleave them either way; assert
                // both tokens are present in the converged content.
                state.assertContains("renamed.md", "A", "B");
            }
        }
    ]
};
