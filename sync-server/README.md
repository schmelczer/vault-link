# Sync server

## API v5

The server is a compare-and-swap store. Content versions do not contain paths or
deletions. A separately versioned file manifest owns the namespace and membership.
All routes below are under `/vaults/:vault_id` and require bearer authentication
(except the WebSocket, which authenticates its first message).

| Endpoint                                                   | Purpose                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `PUT /documents/:document_id`                              | CAS an immutable content version.                                                       |
| `GET /documents/:document_id/metadata`                     | Current version metadata and size without content bytes.                                |
| `GET /documents/:document_id`                              | Current content version, including base64 bytes.                                        |
| `GET /documents/:document_id/versions/:version_id/content` | Immutable raw bytes.                                                                    |
| `GET /file-manifest`                                       | Current file manifest.                                                                  |
| `PUT /file-manifest`                                       | CAS the complete file manifest.                                                         |
| `GET /vault-snapshot`                                      | File manifest, referenced content heads, and event watermark from one read transaction. |
| `GET /events-since?after=N`                                | Every event after N, in order, with the current watermark.                              |
| `GET /ws`                                                  | Ordered event delivery and ephemeral cursor positions.                                  |

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
rows to the latest content versions. Event replay and retry acknowledgements are
also reconstructed from normalized content/manifest rows, without storing a
second complete map in the event table.

Both pushes return a tagged `Accepted` or `StaleBase` response. An accepted file
manifest response returns its assigned file manifest ID. A stale content response
includes metadata and byte length only; clients fetch immutable bytes after applying
their size and exclusion policy. A stale file manifest response includes the complete map.
Accepted requests store their unique request ID and fingerprint in the event row,
atomically with the version. Retrying the exact request reconstructs the original
`Accepted` response from that event before checking the current head, even after
later changes or a restart. Changing a payload while reusing its request ID is
rejected, including reuse across content and file manifest pushes. Session/device
identity is not part of the fingerprint.

File manifest validation rejects duplicate UUID keys (including aliases), missing
content, path aliases, inconsistent directory spelling, and file/ancestor
conflicts. Paths use `/`, NFC normalization, and portable Windows filename
restrictions without imposing a universal total-path byte limit. Alias comparison is NFC → Unicode uppercase →
NFC. `.vault-link-sync` and its aliases are reserved. The server never sanitizes
or allocates a replacement name.

## Ordering and recovery

Every accepted mutation appends one event in the same SQLite write transaction
as its state. Events also provide durable request tracking; there is no separate
receipt table. Event IDs are contiguous safe JavaScript integers;
content/file-manifest version IDs are the event IDs that created them. Rejected
requests and retries of accepted requests append no events. Timestamps never
determine event ordering.

WebSocket messages are `{type: "vaultChanged"}` hints. Clients fetch ordered
history through HTTP from their last incorporated event ID. The server compares
its current history checkpoint after broadcasts and periodically, so missed wakes
and requests interrupted after commit still trigger catchup. Reconnecting sends a
fresh hint without replaying events over the socket. Cursor messages are unchanged.
A fresh client reads `/vault-snapshot`, applies it durably, then replays after its
watermark. Successful HTTP responses include `X-Vault-Link-History`, containing
an event ID and a random event-incarnation token. Clients persist and echo this
checkpoint on later HTTP requests. The server returns HTTP 409 with
`X-Vault-Link-History-Mismatch: 1` before executing a request whose checkpoint is
absent from the current database. Restored backups retain their original prefix;
new events get new tokens even when numeric IDs or request UUIDs are reused.
Restore databases while the server is stopped. Live replacement of open SQLite
files is not supported.
Cursor notifications are ephemeral and do not consume event IDs.
Cursor expiry and disconnect broadcast the remaining clients, including an empty
list when the last client leaves.

## Vault names and database files

Vault names and configured allowlists are trimmed and lowercased consistently.
Empty names, `.` and `..`, path separators, and control characters are rejected.
Other Unicode spellings remain distinct identities, including composed and
decomposed characters.

Databases use `vaults/<sha256-of-normalized-vault-name>.sqlite` underneath the
configured database directory. This prevents filesystem case and Unicode aliases
from sharing a database. This is the only supported storage layout; top-level
`<vault-name>.sqlite` files are not loaded or migrated. Back up the entire database
directory, including the `vaults` subdirectory.

Vault snapshots query metadata and byte lengths without loading document contents.

SQLite uses WAL, `synchronous=FULL`, and `fullfsync` where supported. On Unix, startup also
flushes database directory entries; the filesystem must support those durability
operations. Content, file manifests, and events (including request fingerprints)
are retained indefinitely.

Deploy API v5 clients and server together. The v4 database schema migrates by
adding event-incarnation tokens without deleting content or receipts. Schemas
from before v4 still require a separate database directory and explicit recovery.
Vault databases open and migrate independently on first access; one corrupt or
incompatible vault does not prevent healthy vaults from serving requests.

Diffs are limited to 10,000 items and reconstructed in one pass over Unicode
scalars on a blocking worker, before taking the SQLite writer transaction. The
transaction rechecks request identity and the parent version before committing.
Clients send a snapshot when an edit exceeds the diff-operation budget. Decoded
content is bounded by `max_body_size_mb` as well as the encoded request limit.

A missing configuration file is initialized with durably stored credentials.
Existing configurations must explicitly supply `users.user_configs`; omitted
credentials are rejected instead of generating an unpersisted token at startup.
Base64 increases snapshot body size by about one third; request limits apply to
the encoded JSON body.
