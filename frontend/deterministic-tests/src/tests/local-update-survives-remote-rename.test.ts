import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const localUpdateSurvivesRemoteRenameTest: TestDefinition = {
    description:
        "Client 0 has a local content edit pending while a remote rename for " +
        "the same doc arrives over the WebSocket. The remote rename's internal " +
        "move relocates the disk file from the old path (where the user wrote) " +
        "to the new server path. Previously, the queued LocalUpdate's " +
        "`event.path` was left pointing at the now-vacated old path, so " +
        "`skipIfOversized`'s `getFileSize(event.path)` threw " +
        "`FileNotFoundError`, which `processEvent`'s catch silently swallowed " +
        "as 'Skipping sync event 'local-update' because the file no longer " +
        "exists' — and the user's edit was lost. The fix routes the size " +
        "check through `tracked.path` (the doc's current disk path), " +
        "matching the path `processLocalUpdate` itself reads from.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "v1\n" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        // Pause client 0's WebSocket so the upcoming remote rename buffers
        // there until we've already enqueued client 0's local content
        // edit. This guarantees the LocalUpdate sits in client 0's queue
        // when the rename's RemoteChange drains.
        { type: "pause-websocket", client: 0 },

        {
            type: "rename",
            client: 1,
            oldPath: "doc.md",
            newPath: "renamed.md"
        },
        { type: "sync", client: 1 },

        // Client 0 still believes the file is at `doc.md` (its WebSocket is
        // paused, so the rename hasn't reached it). The user edits content
        // at `doc.md`. This pushes a LocalUpdate(D, path=doc.md,
        // originalPath=doc.md, isUserRename=false) into client 0's queue.
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "v1\nclient 0 edit\n"
        },

        // Resume the WebSocket. The buffered remote rename (server-broadcast)
        // drains. `processRemoteUpdate` does an internal `move(doc.md,
        // renamed.md)` and, because there's a pending LocalUpdate for D,
        // takes the else branch (re-enqueue v_K, setDocument(renamed.md, …)).
        // Then drain reaches the LocalUpdate. Pre-fix: skipped silently.
        // Post-fix: PUTs the user's content to the doc (at its new path,
        // since this is a content-only edit, not a user rename).
        { type: "resume-websocket", client: 0 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(1);
                state.assertFileExists("renamed.md");
                state.assertContent(
                    "renamed.md",
                    "v1\nclient 0 edit\n"
                );
            }
        }
    ]
};
