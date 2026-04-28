import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const catchupCreateAndUpdateNotSkippedTest: TestDefinition = {
    description:
        "Client 1 disconnects (sync disabled). Client 0 creates a doc and " +
        "then updates it. When Client 1 reconnects, the server's catch-up " +
        "stream sends only the doc's *latest* version (the update), not the " +
        "full history. Pre-fix the wire's `is_new_file` was set to " +
        "`creation == latest_version`, so the catch-up flagged the doc as " +
        "non-new even though Client 1 had never seen its creation. Client " +
        "1's `processRemoteChange` then dropped it as a 'stale RemoteChange " +
        "for untracked, non-new document' and the doc was silently lost. " +
        "Post-fix `is_new_file` in the catch-up stream means 'new relative " +
        "to the recipient's watermark' (`creation > last_seen_vault_update_id`).",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        // Establish a baseline so Client 1's last_seen is non-zero before
        // we take it offline. This makes the bug genuinely about catch-up
        // missing the create rather than just an empty-vault first sync.
        { type: "create", client: 0, path: "warmup.md", content: "w\n" },
        { type: "barrier" },

        // Client 1 goes offline.
        { type: "disable-sync", client: 1 },

        // Client 0 creates the doc (vault_update_id v_C, after Client 1's
        // watermark). Client 1 doesn't see this because it's offline.
        { type: "create", client: 0, path: "doc.md", content: "v1\n" },
        // Wait for the create's HTTP to land before the update; otherwise
        // both writes are coalesced into a single POST and the server
        // never sees the doc as "create followed by update".
        { type: "sync", client: 0 },

        // Client 0 updates the doc (vault_update_id v_X > v_C). The
        // server's `latest_document_versions` view now returns the
        // *update* row — its `creation_vault_update_id != vault_update_id`.
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "v1\nupdate\n"
        },
        { type: "sync", client: 0 },

        // Client 1 reconnects. Server's catch-up replays docs with
        // `vault_update_id > last_seen`. For doc.md it sends v_X with
        // `is_new_file` derived from `creation_vault_update_id >
        // last_seen_vault_update_id` (post-fix) — so Client 1 treats it
        // as a fresh create and downloads the latest content.
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state.assertFileCount(2);
                state.assertFileExists("doc.md");
                state.assertContent("doc.md", "v1\nupdate\n");
                state.assertContent("warmup.md", "w\n");
            }
        }
    ]
};
