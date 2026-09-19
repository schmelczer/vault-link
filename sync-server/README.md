# Sync server

## API v4

The server is a compare-and-swap store. Content versions do not contain paths or
deletions. A separately versioned file manifest owns the namespace and membership.
All routes below are under `/vaults/:vault_id` and require bearer authentication
(except the WebSocket, which authenticates its first message).

| Endpoint | Purpose |
| --- | --- |
| `PUT /documents/:document_id` | CAS an immutable content version. |
| `GET /documents/:document_id` | Current content version, including base64 bytes. |
| `GET /documents/:document_id/versions/:version_id/content` | Immutable raw bytes. |
| `GET /file_manifest` | Current file manifest. |
| `PUT /file_manifest` | CAS the complete file manifest. |
| `GET /vault_snapshot` | File manifest, referenced content heads, and event watermark from one read transaction. |
| `GET /events_since?after=N` | Every event after N, in order, with the current watermark. |
| `GET /ws` | Ordered event delivery and ephemeral cursor positions. |

A content push includes a `Device-Id` header and this JSON body:

```json
{
  "requestId": "2e3ac3fe-a8d2-49ef-bdba-30ab5b7336f1",
  "parentVersionId": null,
  "content": { "type": "Snapshot", "value": "aGVsbG8=" }
}
```

`parentVersionId: null` creates previously absent content using the UUID in the
URL. Subsequent pushes name its current version. `Diff` with a `value` array of
numbers/strings is also supported; the server only reconstructs the supplied
snapshot. File modification times are not part of the protocol. Paths and
`Delete` payloads are rejected.

A file manifest push is:

```json
{
  "requestId": "69e6a1ba-1f20-4d81-9ae2-e7812c321e65",
  "parentFileManifestId": 0,
  "entries": { "7534676e-b51a-42d6-8a62-e70a477f731d": "notes/hello.md" }
}
```

The initial empty file manifest has version 0. Upload a new document's content
first, then publish its ID in the file manifest. Removal from the file manifest
deletes membership; content updates never restore membership. Unreferenced
content remains readable.

File manifest versions are stored in `file_manifests`, with one row per
UUID-to-path mapping in `file_manifest_entries`. Each version has a header row
even when its entries are empty. Entries are unique by document ID and exact path
within a version; portable path validation also rejects aliases and directory
conflicts. Reads reconstruct the complete map, and vault snapshots join these
rows to the latest content versions. The version, entries, and complete file
manifest event in `events.event_json` commit atomically. Event replay and retry
acknowledgements continue to use `event_json`.

Both pushes return a tagged `Accepted` or `StaleBase` response. An accepted file
manifest response returns its assigned file manifest ID. A stale content response
includes bytes; a stale file manifest response includes the complete map.
Accepted requests store their unique request ID and fingerprint in the event row,
atomically with the version. Retrying the exact request reconstructs the original
`Accepted` response from that event before checking the current head, even after
later changes or a restart. Changing a payload while reusing its request ID is
rejected, including reuse across content and file manifest pushes. Session/device
identity is not part of the fingerprint.

File manifest validation rejects duplicate UUID keys (including aliases), missing
content, path aliases, inconsistent directory spelling, and file/ancestor
conflicts. Paths use `/`, NFC normalization, at most 240 UTF-8 bytes, and portable
Windows filename restrictions. Alias comparison is NFC → Unicode uppercase →
NFC. `.vault-link-sync` and its aliases are reserved. The server never sanitizes
or allocates a replacement name.

## Ordering and recovery

Every accepted mutation appends one event in the same SQLite write transaction
as its state. Events also provide durable request tracking; there is no separate
receipt table. Event IDs are contiguous safe JavaScript integers;
content/file-manifest version IDs are the event IDs that created them. Rejected
requests and retries of accepted requests append no events. Timestamps never
determine event ordering.

The WebSocket handshake retains `lastSeenVaultUpdateId`. The server sends
`{type: "vaultEvents", headEventId, events}` in increasing order, including events
originated by that client. Each connection drains the database through one sender.
In-memory notifications only wake it; polling covers missed wakes and cancellation
after commit. Reconnect with the last durably processed event ID. The HTTP replay
endpoint uses the same history, so losing the final notification is recoverable.
A fresh client reads `/vault_snapshot`, applies it durably, then replays after its
watermark.
Cursor notifications are ephemeral and do not consume event IDs.

SQLite uses WAL, `synchronous=FULL`, and `fullfsync` where supported. On Unix, startup also
flushes database directory entries; the filesystem must support those durability
operations. Content, file manifests, and events (including request fingerprints)
are retained indefinitely.

API v4 requires fresh vault databases and upgraded clients. Existing database
migration checksums intentionally reject earlier schemas; there is no automatic
erasure or migration. Use a new database directory and preserve old data.
Base64 increases snapshot body size by about one third; request limits apply to
the encoded JSON body.
