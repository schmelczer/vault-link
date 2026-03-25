import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Stale doc kept on disk creates duplicate content after create-merge.
 *
 * Found by: E2E test log analysis (log.log, process 672773)
 *
 * Root cause sequence:
 * 1. Client 1 has document D1 tracked at path "target.md"
 * 2. Client 0 renames D1 to "moved.md" on the server
 * 3. Client 1 (offline) creates a new file at "moved.md"
 * 4. Client 1 reconnects — the create is sent to the server
 * 5. Server merges the create with D1 (at "moved.md") → MergingUpdate with D1
 * 6. ensureUniqueDocumentId finds D1 at "target.md" → stale doc
 * 7. "target.md" was locally modified during the create's HTTP request
 *    → hasLocalChanges = true → file kept on disk, VFS record removed
 * 8. On the next reconciliation, orphaned "target.md" is re-synced
 *    as a new document. Now BOTH "target.md" and "moved.md" contain
 *    the original content from D1 — violating the content-uniqueness
 *    invariant.
 *
 * The server pause is used to keep the create HTTP request in-flight
 * while the local file at D1's old path is modified (step 7).
 */
function verifyNoDuplicateContent(state: ClientState): void {
    const entries = [...state.files.entries()];

    // The word "original" was D1's initial content. After the create-merge,
    // it should appear in at most ONE file. If the stale orphan was re-synced
    // as a separate document, "original" will appear in multiple files.
    const filesContainingOriginal = entries.filter(([, content]) =>
        content.includes("original")
    );

    assert(
        filesContainingOriginal.length <= 1,
        `Content "original" found in ${filesContainingOriginal.length} files: ` +
            `${filesContainingOriginal.map(([p]) => p).join(", ")}. ` +
            `This means the stale doc orphan was re-synced, creating duplicate content.\n` +
            `Files:\n${entries.map(([k, v]) => `  ${k}: "${v}"`).join("\n")}`
    );
}

export const staleDocOrphanDuplicateContentTest: TestDefinition = {
    name: "Stale Doc Orphan Creates Duplicate Content After Create-Merge",
    description:
        "When a create merges with an existing document, the stale VFS " +
        "record is removed but the file is kept on disk (local changes). " +
        "If the orphaned file is later re-synced as a new document, the " +
        "original content appears in multiple files.",
    clients: 2,
    steps: [
        // ── Setup: both clients share D1 at "target.md" ──
        { type: "create", client: 0, path: "target.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // ── Client 1 goes offline ──
        { type: "disable-sync", client: 1 },

        // ── Client 0 renames the document to a new path ──
        // Server now has D1 at "moved.md"
        {
            type: "rename",
            client: 0,
            oldPath: "target.md",
            newPath: "moved.md"
        },
        { type: "sync", client: 0 },

        // ── Client 1 (offline) creates a file at D1's new server path ──
        // Client 1 doesn't know D1 was renamed there.
        {
            type: "create",
            client: 1,
            path: "moved.md",
            content: "unrelated-content"
        },

        // ── Pause server to stall the create HTTP request ──
        { type: "pause-server" },

        // ── Enable sync on client 1 ──
        // scheduleSyncForOfflineChanges runs:
        //   "target.md": D1, hash matches → no update
        //   "moved.md": no metadata → create scheduled
        // The create HTTP request stalls (server frozen).
        // enableSync waits up to 10 s for WebSocket then returns.
        { type: "enable-sync", client: 1 },

        // ── Modify D1's old path while the create is in-flight ──
        // This makes hasLocalChanges = true when ensureUniqueDocumentId
        // checks the stale doc at "target.md".
        {
            type: "update",
            client: 1,
            path: "target.md",
            content: "original extra-edit"
        },

        // ── Resume server ──
        // Create completes: server merges with D1 → MergingUpdate
        // ensureUniqueDocumentId: D1 at "target.md" → stale doc
        // hasLocalChanges("target.md"): "original extra-edit" ≠ "original" → true
        // File kept, VFS record removed.
        //
        // WebSocket connects → second reconciliation detects orphaned
        // "target.md" → re-synced as new document → DUPLICATE CONTENT.
        { type: "resume-server" },

        // ── Settle ──
        { type: "sync" },
        { type: "sync" },
        { type: "barrier" },

        // ── Verify: "original" must not appear in multiple files ──
        { type: "assert-consistent", verify: verifyNoDuplicateContent }
    ]
};
