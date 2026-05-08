import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const localRenameSurvivesRemoteRenameTest: TestDefinition = {
    description:
        "Drain processes a RemoteChange (remote rename for doc D) while a " +
        "LocalUpdate (user rename of D) is also queued behind it. " +
        "`processRemoteUpdate` moves the disk file and, because there is a " +
        "pending LocalUpdate, takes the else branch — but its setDocument " +
        "uses the stale `record.path` (= the user-rename target) instead of " +
        "the actualPath the file just moved to. The queued LocalUpdate then " +
        "reads from `record.path`, throws FileNotFoundError, and is " +
        "silently dropped. Setup pins the queue order: a sentinel " +
        "LocalUpdate keeps drain busy on a SIGSTOPped HTTP roundtrip while " +
        "we resume client 0's WebSocket (enqueues RemoteChange) and then " +
        "user-rename D (enqueues LocalUpdate after the RemoteChange). On " +
        "server resume the drain pops the sentinel, then RemoteChange, then " +
        "LocalUpdate — exactly the order that triggers the bug.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "create", client: 0, path: "doc.md", content: "v1\n" },
        { type: "create", client: 0, path: "sentinel.md", content: "s\n" },
        { type: "barrier" },

        // Pause client 0's WebSocket so the upcoming remote rename buffers.
        { type: "pause-websocket", client: 0 },

        // Server applies remote rename of doc.md -> remote.md. Broadcast
        // is buffered on client 0's WebSocket.
        { type: "rename", client: 1, oldPath: "doc.md", newPath: "remote.md" },
        { type: "sync", client: 1 },

        // Pause the server BEFORE arming the sentinel, so the sentinel's
        // HTTP request will buffer at the kernel and keep drain occupied.
        { type: "pause-server" },

        // Sentinel: a LocalUpdate on a *different* doc that drain pops
        // first. Its HTTP roundtrip stalls on SIGSTOP, freezing drain
        // until we resume the server. While drain is frozen we can grow
        // the queue with additional events whose order we control.
        {
            type: "update",
            client: 0,
            path: "sentinel.md",
            content: "s\nedit\n"
        },

        // Resume the WebSocket — buffered remote rename enqueues as a
        // RemoteChange. Drain is still stuck on the sentinel HTTP.
        { type: "resume-websocket", client: 0 },

        // User renames doc.md -> local.md on client 0. queue.enqueue
        // mutates the doc's record.path to "local.md" and pushes a
        // LocalUpdate(rename) onto the tail of the queue. Queue is now
        // [sentinel-update (in-flight), RemoteChange, LocalUpdate-rename].
        { type: "rename", client: 0, oldPath: "doc.md", newPath: "local.md" },

        // Resume the server. Drain pops sentinel-update (succeeds), then
        // RemoteChange. Pre-fix: processRemoteUpdate moves disk
        // local.md -> remote.md, takes the else branch, and
        // setDocument(record.path = "local.md", …) leaves record.path
        // stale. Drain pops the LocalUpdate-rename and reads from the
        // stale record.path, hits FileNotFoundError, silent skip.
        // Post-fix: when a local event is pending, we re-queue the
        // remote update without touching disk or record, so the local
        // rename drains first and both ends converge.
        { type: "resume-server" },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(2);
            }
        }
    ]
};
