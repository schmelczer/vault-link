import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renameChainDuringPendingCreateTest: TestDefinition = {
    description:
        "User creates a doc, then renames it twice while the LocalCreate's " +
        "HTTP roundtrip is still in flight (server paused). Each rename " +
        "pushes a LocalUpdate whose `documentId` is the create's Promise " +
        "(see `pendingDocumentId` in `SyncEventQueue.enqueue`). After the " +
        "create resolves, the first rename drains successfully and " +
        "`setDocument` walks `events[]` to retarget queued LocalUpdates' " +
        "`event.path` to the new disk location — but the comparison " +
        "`e.documentId === record.documentId` mismatches the still-Promise " +
        "references, so the second rename's `event.path` stays at the " +
        "vacated previous slot. On the next drain step `skipIfOversized`'s " +
        "`getFileSize(event.path)` throws FileNotFoundError, which " +
        "`processEvent` swallows as 'Skipping sync event ... because the " +
        "file no longer exists' — losing the user's final rename. " +
        "Post-fix: `resolveCreate` (and the displacement-merge branch in " +
        "`processCreate`) swap the Promise references for the resolved id " +
        "before `setDocument` runs, so retarget works.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        // Pause the server so client 0's create stalls on the HTTP PUT
        // while we queue rename events behind it.
        { type: "pause-server" },

        { type: "create", client: 0, path: "first.md", content: "v1\n" },
        {
            type: "rename",
            client: 0,
            oldPath: "first.md",
            newPath: "second.md"
        },
        {
            type: "rename",
            client: 0,
            oldPath: "second.md",
            newPath: "third.md"
        },

        // Resume — drain pops LocalCreate (now resolves), then the two
        // queued LocalUpdates. Pre-fix: only the first rename's
        // file-system effect lands; the second is silently dropped.
        // The server ends up with the doc at second.md, leaving
        // client 0's local third.md untracked / out-of-sync.
        { type: "resume-server" },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(1);
                state.assertFileExists("third.md");
                state.assertContent("third.md", "v1\n");
            }
        }
    ]
};
