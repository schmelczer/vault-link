> Historical handover: its client journaling, recovery-archive and filesystem
> durability descriptions are superseded by the direct-application model in
> [the sync client README](frontend/sync-client/README.md). The current client
> saves complete metadata and reconciles current disk contents after interruption.

# Sync engine v4 handover

Prepared on 2026-09-19. This records the implementation delivered in the preceding
work session: its starting point, intended behavior, changes and their reasons,
validation, and integration work still required.

Follow-up on 2026-09-19: file modification times have since been removed from the
server schema/protocol, client snapshots, and recovery records. Concurrent binary
or unmergeable edits now keep the server version, with displaced local bytes
retained in recovery; changes on only one side still keep that side. References
to `mtime` below describe the earlier implementation and are superseded by this
change. See the server and client READMEs for the current contracts.

Further follow-up on 2026-09-19: request tracking is now part of `events`, using
unique `request_id` and `request_fingerprint` columns. The separate
`request_receipts` table and duplicated response JSON have been removed. Retries
check the fingerprint and reconstruct the original `Accepted` response from the
stored event before CAS. References to separate receipts below describe the
earlier implementation and are superseded by this change.

File manifest storage follow-up on 2026-09-19: complete maps are now stored as rows in
`file_manifest_entries`, keyed by `(file_manifest_id, document_id)`, with exact path
uniqueness per version. `file_manifests` retains a header for every accepted version,
including empty maps. File manifest reads reconstruct the map from these rows, and
vault snapshots join them to the latest content versions. Event rows contain only
ordering and request-deduplication metadata; replay and retry acknowledgements
reconstruct events from normalized document/manifest rows. References below to JSON file
manifest storage describe the earlier implementation.

The baseline is commit `1619c51` (`Migrate server to CAS only`). The implementation
changes are currently in the working tree/index, rather than a new implementation
commit. The file inventory below describes the rewrite relative to that baseline.

The following changes must not be attributed to this implementation:

- While this handover was being written, additional unstaged edits appeared in
  `sync-server/src/app_state/database/migrations/20241207143519_bootstrap.sql`,
  `sync-server/src/server/endpoints/get_file_manifest.rs`,
  `sync-server/src/server/endpoints/put_file_manifest.rs`,
  `sync-server/src/server/endpoints/vault_snapshot.rs`,
  `sync-server/src/server/endpoints/put_file_content.rs`, and
  `sync-server/src/server/endpoints/put_file_content/tests.rs`. They were left alone
  and are outside this handover's implementation inventory. The earlier passing
  validation applies to the rewrite as delivered, represented by the staged
  implementation at the start of this handover, not subsequent edits. Review and
  validate the final SQL before starting a new database.

This handover task added only this document; it did not modify implementation
files or change staging decisions.

## Initial state

The repository was in the middle of a protocol migration. It was not a functioning
v4 implementation with a few missing routes.

| Area               | Starting behavior                                                                                                                                                                                                                      | Why it needed to change                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server protocol    | Advertised API v3. `PUT /documents/:id` already used a parent version, request UUID, immutable versions, SHA-256 request fingerprints, and durable acknowledgements. Concurrent text merging had already been removed from the server. | Preserve the existing content CAS design and extend its durability model to namespace changes. This rewrite did not originate server-side CAS or idempotency.            |
| Content and names  | A document version also contained `relative_path` and `is_deleted`; pushes carried a path and supported `Delete`. The server sanitized and allocated available paths.                                                                  | Content history and namespace decisions were coupled. Whole rename sequences and cross-document conflicts could not be decided atomically as a file manifest.                 |
| Server persistence | `documents`, a latest-version view, and `push_acknowledgements`; new IDs were allocated from the maximum document update ID inside a write transaction.                                                                                | There was no common durable event stream for content and file manifests, or file manifest history.                                                                                 |
| Broadcasts         | A completed write committed and then broadcast its document metadata. The originating device was skipped. Reconnection fetched latest document heads rather than every event.                                                          | Post-commit task scheduling could change notification order; a crash after commit could lose a wakeup. Latest heads are not an ordered history of namespace transitions. |
| Client protocol    | Advertised API v2. It still used the earlier create/text/binary/delete service calls and expected `FastForwardUpdate` / `MergingUpdate`.                                                                                               | The client had not caught up with the server's previous CAS migration, let alone the proposed file manifest protocol.                                                         |
| Client scheduling  | `Syncer`, `UnrestrictedSyncer`, a configurable concurrent queue, document locks, mutable records, and in-memory promises coordinated operations.                                                                                       | Whole-file-manifest changes need a consistent view across documents. A single durable reconciliation loop is easier to reason about when performance is secondary.            |
| Client metadata    | Persisted document metadata and an update watermark, with mutable runtime records and gap tracking.                                                                                                                                    | No persisted exact request/response workflow or filesystem application journal tied disk changes to metadata advancement.                                                |
| Filesystem         | Read/write/rename/delete operations, an atomic text updater, an in-memory safety wrapper, and native line-ending conversion.                                                                                                           | The interface did not promise durable data and directory updates or crash-recoverable multi-file moves.                              |
| Content comparison | A 32-bit rolling checksum.                                                                                                                                                                                                             | Collisions could incorrectly hide edits or identify unrelated files as a rename.                                                                                         |
| Reset/settings     | Reset cleared local tracking; settings could cause a vault reset. Persistence had no explicit power-loss contract.                                                                                                                     | Clearing uncertain requests or application state could lose recovery information or apply it to the wrong vault.                                                         |

The Obsidian plugin, CLI client, legacy test fixtures, and their adapters were
explicitly outside the implementation scope.

## Expected result and selected policies

The requested result is a simple server CAS store and a client that owns all
reconciliation. The content algorithm follows the fetch/merge/push model in
[Conflict-Free Three-Way Text Merging](https://schmelczer.dev/articles/reconcile-text-3-way-merge/),
including recording the sent snapshot after acceptance and retrying an uncertain
request with its original idempotency key.

The implemented invariants are:

1. Document UUIDs identify content; a file manifest maps UUIDs to paths and owns
   membership. A content push cannot rename, delete, or restore membership.
2. File manifest acceptance replaces the entire map only when its parent is current.
   Every referenced document must already have content.
3. An accepted content or file manifest mutation commits its state, event, and receipt
   together. Each vault has one total order; separate vaults have separate orders.
4. Each WebSocket sends persistent events in that order, including the sender's
   own events. Cursors remain ephemeral and do not consume event IDs.
5. The client persists its exact request before sending. An unknown outcome is
   resolved before advancing to newer remote state.
6. The client advances a merge base to what was actually incorporated or accepted,
   never to an assumption about the current live file.
7. Filesystem application has a durable journal. Every affected source is staged
   before destinations are installed, so swaps and cycles do not overwrite files.
8. A received event watermark becomes durable with the corresponding state or
   recoverable application obligation. Excluded downloads remain explicit work.

The conflict policies implemented alongside these invariants are:

| Situation                                         | Decision                                                                                                                                                        | Reason                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Same UUID, local path unchanged                   | Use the server path, including absence.                                                                                                                         | Incorporate remote changes.                                                                             |
| Same UUID, remote path unchanged                  | Use the local path, including absence.                                                                                                                          | Preserve local intent.                                                                                  |
| Same UUID, both paths changed                     | Use the server path, including absence.                                                                                                                         | The requested deterministic tie-breaker.                                                                |
| Different UUIDs claim conflicting paths           | Keep both identities. A selected path matching the server wins priority; UUID order resolves other ties. Give displaced documents deterministic conflict names. | A per-ID merge alone cannot guarantee one-to-one paths.                                                 |
| Delete versus content edit                        | Membership follows the file manifest merge. Preserve locally displaced bytes in recovery; do not automatically recreate membership.                                  | Avoid deletion/resurrection loops while retaining observed data.                                        |
| First sync, existing local text at a remote path  | Adopt the remote UUID and merge against an empty parent.                                                                                                        | There is no known common ancestor; neither existing side should silently overwrite the other.           |
| Concurrent binary/unmergeable changes             | Larger originating mtime wins; server wins ties.                                                                                                                | A defined policy is necessary when text reconciliation does not apply. Clock skew remains a limitation. |
| Rename notification                               | Preserve identity through the ordered logical move hints.                                                                                                       | Retain identity through online rename sequences.                                                        |
| Unobserved/offline rename                         | Infer only from a unique, nonempty content hash match on both sides; otherwise treat as delete/create.                                                          | Identical files and rename-plus-edit sequences cannot be identified reliably from snapshots alone.      |
| Deliberate notified delete/recreate               | Allocate a new UUID, even at the same path with identical bytes.                                                                                                | A new document must not inherit the deleted document's identity accidentally.                           |
| Portable-name conflict                            | Repair names client-side; reject invalid canonical file manifests server-side.                                                                                       | Every client must receive one valid, unambiguous namespace.                                             |
| Ignored, oversized, or unmaterialized remote file | Preserve membership and remember its remote head.                                                                                                               | Skipping a download must not publish a deletion.                                                        |

This is not a proof of a universally perfect sync engine. Power-loss recovery
depends on the adapter/storage contracts below. Snapshot-based observation cannot
recover writes that were never observed or unambiguously reconstruct offline
identity. Automatic text merging also cannot guarantee semantic correctness of
the resulting prose or code.

## Server changes and rationale

### Independent namespace and content CAS

`PutFileContent` now contains `requestId`, nullable `parentVersionId`, `mtime`, and
`content`. `content` accepts `Snapshot` or `Diff`. Paths, delete payloads, and other
unknown fields are rejected. The server still reconstructs a transport diff against
the supplied parent; it does not reconcile competing edits. The existing guard
against the minimum signed integer in diff lengths was retained.

`mtime` is the originating file time in milliseconds, stored as a finite floating
point value within the JavaScript date range. It is distinct from the server's
commit time. This lets clients apply the selected binary policy without treating
download time as a new edit.

`PushFileManifest` contains `requestId`, `parentFileManifestId`, and `entries`, where entries
are the complete UUID-to-path map. The empty initial file manifest has ID 0. A custom
map deserializer rejects repeated UUID keys, including alternate spellings of the
same UUID; an ordinary JSON map decoder would silently keep one value. A sorted
map gives request fingerprinting a stable key order.

Both mutation kinds return `Accepted` or `StaleBase`. A stale content response
contains the current bytes; a stale file manifest response contains the current map.
Only accepted mutations get durable receipts. Rejected requests have no state
effect and may receive a newer stale base if retried later.

### Schema and transaction boundary

The bootstrap schema was replaced with a fresh v4 schema:

| Object                                           | Purpose and reason                                                                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events`                                         | AUTOINCREMENT IDs, request IDs, and fingerprints provide the common order and durable idempotency namespace. IDs are constrained to JavaScript's safe integer range. Event payloads are reconstructed from normalized rows. |
| `documents`                                      | Immutable content versions reference their creating event; no path or deletion fields. UUIDs use the BLOB representation expected by SQLx's UUID binding. `mtime`, author, device, and server timestamp are retained. |
| `documents_by_id` and `latest_document_versions` | Find a UUID's current content without namespace lookups.                                                                                                                                                              |
| `file_manifests` and `file_manifest_entries`     | Immutable manifest headers and normalized UUID/path rows keyed by their creating event ID. A file manifest version need not equal the latest event ID because content events can follow it.                              |

The write transaction performs event/request lookup before CAS, then head validation,
event allocation, normalized state insertion, and commit. Request lookup must come
first: a retry of an accepted request is still successful after another
client advances the head. Reusing a request UUID with different content, parent,
document ID, or operation type is rejected. Session/device identity is excluded
from the fingerprint so a restarted client can recover its old outcome.

Read operations were consolidated in `queries.rs`, and write operations in
`mutations.rs`. Runtime SQL queries replace the old schema-dependent SQLx macro
queries in this path. This keeps the new schema and transaction logic together
without requiring the old prepared-query cache to describe v4.

SQLite now explicitly uses WAL, `synchronous=FULL`, `fullfsync`, and foreign keys.
On Unix, database creation also flushes the containing directory and ancestors.
The reason is durability of both transaction contents and newly created directory
entries. These settings still depend on the platform/filesystem honoring flushes.

No migration or automatic deletion of old databases was added. Replacing the
bootstrap migration deliberately makes old migration checksums incompatible.
Use a fresh database directory and retain old data separately.

### Endpoint and replay changes

Paths below are relative to `/vaults/:vault_id`:

| Endpoint                                                   | Change and rationale                                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /documents/:document_id`                              | Existing route becomes a thin content-only CAS handler. Database mutation code owns the complete atomic operation.                                                           |
| `GET /documents/:document_id`                              | Retained; returns current content using the new metadata shape.                                                                                                              |
| `GET /documents/:document_id/versions/:version_id/content` | Retained; clients fetch immutable bases for merging.                                                                                                                         |
| `GET /file-manifest`                                            | New; retrieves canonical membership and names.                                                                                                                               |
| `PUT /file-manifest`                                            | New; validates and CAS-replaces the complete namespace.                                                                                                                      |
| `GET /vault-snapshot`                                      | New; returns the file manifest, referenced content heads, and event watermark from one read transaction. Prevents a bootstrap gap between separately read state and history.      |
| `GET /events-since?after=N`                                                       | New; returns every later event in increasing order with the transaction's watermark. Negative/ahead-of-history cursors are rejected rather than silently resetting a client. |
| `GET /ws`                                                  | Reworked to send the same ordered durable event history.                                                                                                                     |
| `GET /documents`                                           | Removed; latest document rows no longer describe membership or preserve namespace transitions.                                                                               |

WebSocket messages use `vaultEvents` batches containing `events` and
`headEventId`. The handshake retains `lastSeenVaultUpdateId`. One sender per
connection drains the database in order; broadcasts are only wake hints. A
two-second timer also drains the log, covering lost wakes and commit-before-notify
crashes. Broadcast lag triggers another drain rather than loss of persistent
events. HTTP replay is available independently of the socket.

Cursor broadcasts were adapted to the new notification wrapper but remain
ephemeral. Persistent events no longer filter out their originating device:
filtering them would create holes in that client's event sequence.

### Portable file manifest validation

Validation now checks the whole namespace, not just individual strings:

- Relative `/`-separated paths and NFC normalization, without a universal
  total-path byte limit.
- No empty, `.` or `..` components; no backslashes, controls, Windows-forbidden
  characters, trailing dots/spaces, or reserved device names. The device-name
  checks also cover extension forms, trailing spaces in the stem, and the
  superscript COM/LPT digit variants.
- `.vault-link-sync` and case/normalization aliases are reserved.
- Comparison uses NFC → Unicode uppercase → NFC.
- No duplicate/alias paths, file-versus-ancestor conflicts, or inconsistent
  directory spelling such as `Notes/a.md` alongside `notes/b.md`.
- Every UUID must refer to existing content before membership is accepted.

The server rejects invalid input instead of allocating or sanitizing names. This
keeps the canonical update exactly equal to the file manifest whose CAS the client
requested. Client and server implement the same portable-name policy.

## Client changes and rationale

### Persistent state and the three file manifests

The three conceptual file manifests are represented as follows:

| Concept                     | Representation                                                         | Why                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incorporated server base, B | `state.fileManifest` with its version ID                                   | A received map becomes the base only after its application is durable or journaled for recovery.                                                                        |
| Last submitted file manifest, S  | `state.pending.request.entries` while a file manifest request is unresolved | Freeze the exact request and parent across network failures and restarts. On acceptance, this exact S becomes B.                                                        |
| Current local view, L       | `state.local`, refreshed by complete scans and logical notifications   | Preserve changes made while an earlier S was in flight. It also tracks unmaterialized/excluded remote membership; it is more than a raw listing of existing disk files. |

S is not kept as a redundant permanent third field after its outcome is resolved.
On acceptance it becomes the incorporated base. On rejection the client merges B,
the current L, and the returned remote map, then prepares a new request with a new
UUID. This preserves the three-way semantics without maintaining duplicate state.

The new format also stores per-document incorporated content metadata and hash,
observed hash, materialization/bootstrap flags, `lastSeenUpdateId`, deferred
`remoteHeads`, the initial vault snapshot while bootstrap is incomplete, pending
requests/responses, and a filesystem application journal.

`Database.commit` clones and saves the complete value before replacing in-memory
state. A save is marked uncertain before it is attempted. If it fails, the next
attempt reloads durable state before doing more work; a failed save may have
persisted either complete version. This avoids continuing from an assumed outcome.

State is bound to the remote URI and vault name. Incompatible formats and live
vault rebinding are rejected instead of silently clearing recovery information.
A truly empty, uninitialized state can be rebound for initial configuration.

### One reconciliation loop

The configurable queue and `UnrestrictedSyncer` were replaced by one serialized
loop per vault. This intentionally trades throughput for a smaller set of states
that can overlap. Its normal progression is:

1. Reload metadata after any uncertain save and recover any filesystem journal.
   Recovery runs before a network ping, so an offline server does not block it.
2. Initialize server configuration; if necessary, persist and apply a consistent
   bootstrap vault snapshot.
3. Resolve the exact pending request and persist its response before processing
   newer remote state.
4. Scan local files, applying ordered logical create/delete/move hints.
5. Replay HTTP events from the durable cursor. Require contiguous IDs and the
   advertised watermark; do not silently skip a missing event.
6. Apply file-manifest/content changes, retaining remote heads for deferred downloads.
7. Rescan, retry newly eligible deferred content, and prepare one next content or
   file manifest submission.
8. Repeat while there is work; otherwise wake on notifications or a five-second
   timer. Transient failures retry at the configured network interval.

WebSocket batches wake this loop. The client uses HTTP replay as its authoritative
event input, avoiding separate merge paths for HTTP and socket delivery. A dirty
flag and completion handling preserve wakes arriving while an attempt finishes.
`waitUntilFinished()` follows successive active attempts and reports failures.

The exact content snapshot, mtime, hash, request ID, parent, and optional cursors
are persisted before sending. After acceptance, the base hash comes from those
sent bytes, not a later disk read. A lost response therefore cannot cause an edit
to be merged into itself. Stale responses cause a client-side merge, and rejected
submission bytes are retained in recovery before the request is cleared.

New UUIDs are saved before network use. Initial content is accepted before its
UUID is published in the file manifest. A crash between those operations can leave
unreferenced content, which is retained and harmless to the visible namespace.
It does not leave a file manifest pointing to absent content.

### Scanning, identities, and conflicts

Scans must complete or fail. A disappearing file during a scan is retried rather
than interpreted from a partial listing. Ignored paths, files above the configured
size limit, and files not yet materialized are handled explicitly so an unavailable
local copy does not masquerade as deletion.

Known online moves are applied in notification order, including directory-prefix
moves. Logical delete/create notifications distinguish replacement from editing.
Offline inference requires exactly one missing identity and one unknown path with
the same nonempty SHA-256 hash. Initial same-path adoption uses portable path
comparison. On normalization-insensitive filesystems, an accessible known NFC
spelling is retained when a scan reports its decomposed alias.

A local generation counter invalidates a prepared merge or push if a notification
arrives during scanning, remote fetches, or planning. The loop rescans rather than
applying the stale plan. This addresses, for example, moving a file and creating a
different file at its old path while remote content is being fetched.

`file-manifest.ts` first performs the requested per-UUID three-way merge, then allocates
valid paths. Server-selected occupants get priority; remaining ties use UUID
ordering. Conflict suffixes contain the UUID, including file/ancestor conflicts.
Invalid components are repaired, but long paths are not silently flattened into
UUID filenames. Comparing a candidate with each
occupied path individually avoids an allocation loop when the temporary occupied
set itself contains overlapping desired and actual paths.

### Content reconciliation

`content.ts` centralizes snapshot serialization and merging. It compares exact
bytes for unchanged-side fast paths, fetches immutable bases when needed, and
calls `reconcile` for valid UTF-8 content with a mergeable extension. Unknown
first-contact text uses an empty parent. Binary or otherwise unmergeable concurrent
content follows originating mtime, with the server winning ties.

Optional local cursor positions are transformed through text reconciliation and
passed to the adapter with the output. Text merge output uses the larger input
mtime. UTF-8 BOM is decoded as an actual character during merging, and native
line-ending conversion was removed. Existing bytes and CRLF are not rewritten
merely because another platform downloaded the file.

The old rolling checksum was replaced by asynchronous Web Crypto SHA-256. Cursor
tracking was updated to await hashes, find remote cursors by document UUID, and
resolve their display path through the local file manifest. Missing/unreadable local
files mark ephemeral cursor data as prior instead of breaking synchronization.

### Filesystem transaction and crash recovery

`FileOperations` now bridges the metadata store and the filesystem with a persisted
application journal. It does not assume these two stores share a transaction.

Each application gets a unique transaction directory under
`.vault-link-sync/transactions`. Each affected document has a source staging path,
an output path, expected/replacement snapshots, source/destination names, and phase:
`planned`, `staged`, `prepared`, `installing`, or `installed`.

The application sequence and reasons are:

| Action                                                                   | Why it is needed                                                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persist the complete plan before visible mutations                       | Restart must know what it was trying to do. The plan includes mergeable extensions so recovery is independent of server availability.                                 |
| Move all affected sources into staging before installing any destination | Rename swaps/cycles and paths becoming ancestor directories cannot overwrite another source. Content replacement and deletion use the same retained-source machinery. |
| Detect an existing staging slot on recovery                              | It proves that the source move happened even if the subsequent metadata save failed.                                                                                  |
| Reconcile a staged source that changed after planning                    | Preserve observed external edits made between the expected snapshot and staging.                                                                                      |
| Persist the prepared result before creating its output file              | Restart must not merge an already merged result a second time.                                                                                                        |
| Persist `installing` before the atomic rename                            | If its origin is subsequently absent, recovery can recognize that installation completed even if its acknowledgement/save was lost.                                   |
| Require exclusive creation and no-replace renames                        | A concurrent destination must cause a retry/conflict, not be silently overwritten.                                                                                    |
| Stage an unexpected file occupant as another UUID with a conflict path   | Preserve an unrelated file that appeared at the destination or blocked an ancestor.                                                                                   |
| Preserve a nonempty blocking directory and rename the incoming document  | Unmanaged descendants must not be recursively deleted to make space.                                                                                                  |
| Prune only empty implicit directories                                    | Directories are not synchronized objects; files must not be erased by cleanup.                                                                                        |
| Remove staged/output artifacts, then commit the planned next state       | Completed applications do not become permanent byte/state archives; interrupted cleanup is retried while the active journal still exists.                              |

An external deletion observed before staging prevents automatic resurrection.
Recovery artifact creation is idempotent: an existing artifact is checked for the
expected bytes instead of overwritten.

Rejected request snapshots are stored separately under
`.vault-link-sync/requests`, with request IDs and identifying JSON. No recovery
artifact or orphan-content garbage collector was added. Ordinary transaction
artifacts are removed on completion; rejected-request snapshots remain explicit
recovery material.

### Lifecycle, settings, transport, and compatibility

`SyncClient.create` requires strong adapters and loads persisted state. Destruction
stops work and flushes local changes. Settings and engine saves serialize complete
replacements through the same persistence store so one cannot overwrite newer
data from the other. The client does not coordinate separate processes accessing
the same local vault.

`reset()` restarts transports/tracking; it no longer clears pending requests or
application journals. Changing a live vault requires a separate state store and
client. Settings saves are assumed to succeed; settings are saved before becoming
visible to listeners, and getters copy the settings and ignore-pattern array to
prevent accidental in-place mutation.

Public notification methods enqueue work instead of waiting for convergence.
Call `waitUntilFinished()` to await the active attempt. Sync status now checks the
requested path's manifest, content hash, exclusions, pending request, and active
application state. Remaining-operation reporting is a busy indicator rather than
the old concurrent queue length. Successful local submissions and remote filesystem
applications create history entries; the history UI is not a durable audit log.

The service layer now exposes typed vault-snapshot/event/file-manifest/content operations.
Durable retry ownership moved out of its old `retryForever` request builders and
into the loop. Requests have a 30-second abort timeout; authentication errors and
permanent 4xx responses are distinguished from transient failures. The proper
`Device-Id` header is used. A rejected initial ping is no longer cached forever,
so startup while offline can recover on retry.

The existing optional telemetry wiring was retained. Its build-injected version
constant now has a development fallback so importing source outside webpack does
not throw. No new telemetry service was introduced.

The unused `syncConcurrency`, `diffCacheSizeMB`, and `minimumSaveIntervalMs`
settings and the old content cache/queue scaffolding were removed.
`nativeLineEndings` remains accepted by the creation type but no longer transforms
content. These compatibility surfaces should be reviewed when adapters/UI are
updated, rather than assumed to retain their former effects.

## Required adapter contract and remaining integration

No production Obsidian or CLI adapter was upgraded in this work. Their old
interfaces are incompatible and will require implementation changes before they
can use the v4 client.

| Adapter responsibility | Required guarantee                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing and reading    | Complete enumeration and coherent bytes/mtime snapshots; absence must be distinguishable from failure. Read races must reject instead of returning partial snapshots.                              |
| Path access            | Stay inside the vault; reject symlinks, ancestor symlink traversal, hardlinks, and special files. Staging and visible files must share a filesystem.                                               |
| `write`                | Atomically create a complete file exclusively. A crash leaves the path absent or complete, never partially written. Preserve supplied mtime and supported cursor metadata.                         |
| `rename`               | Atomic same-filesystem move without replacing an existing destination. Flush source data and both affected directories before resolving.                                                           |
| Directory operations   | Durable recursive creation, including ancestors. Pruning uses only directory removal and never unlinks descendant files.                                                                           |
| Metadata persistence   | Atomically replace the complete state and flush data/directory entries before resolving. A failed save may leave either complete value, which must be reloadable.                                  |
| Notifications          | Report logical external operations; suppress self-generated create/delete/move notifications. Treat an editor's atomic save as a content update rather than a deliberate document delete/recreate. |
| State placement        | Keep metadata outside the user-file namespace or in the reserved internal directory.                                                                                                               |

Known boundaries and deferred work:

- No automatic migration of existing server databases or v2/v3 client stores.
- No guarantee for writes that occur and disappear between observations, or
  perfect identity reconstruction while notifications are unavailable. Logical
  notification hints themselves are not an external filesystem operation log.
- No multi-file atomic visibility to arbitrary external programs: staging is
  recoverable, but an external reader can see a transaction partway through.
- No hardware power-cut testing or production-adapter durability certification.
- No bounded history/recovery storage, event pagination, large-vault performance
  optimization, or guarantee against starvation under continuous competing writes.
- No protection against an administrator independently deleting server history,
  pending requests, or recovery state. An ahead-of-history cursor fails rather
  than silently accepting a replaced/truncated server database.
- No syncing of empty directories or special filesystem objects.
- No new migration of the history viewer, plugin, CLI, repository-wide architecture
  docs, or legacy testing setup. They may still describe the earlier protocol.

The next integration work is to implement and verify real adapters, update the
excluded callers to v4 and the new notification semantics, and port the behavior
checks into maintained tests. Fresh-state rollout must preserve old data and use
compatible server/client versions together.

## Validation performed

These results were obtained at the end of the implementation task, before the
subsequent edits noted above. They are not a claim that every current
working-tree change or every legacy test passes.

| Check                                                                       | Result and scope                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `cargo build --manifest-path sync-server/Cargo.toml --quiet`                | Passed for the implemented server.                                                                                  |
| `cargo test --manifest-path sync-server/Cargo.toml export_bindings --quiet` | Passed 15 binding-export tests; used to generate the Rust wire types. This is not a behavioral server-suite result. |
| Strict TypeScript check of the production client entrypoint                 | Passed. Command below.                                                                                              |
| `npm run build -w sync-client` from `frontend`                              | Passed for both browser and Node production bundles.                                                                |
| `git diff --check`                                                          | Passed for the implementation diff.                                                                                 |
| Live server CAS/order checks                                                | Passed with an isolated local server and fresh temporary databases.                                                 |
| Client reconciliation and interruption checks                               | Passed against that server using a memory filesystem/persistence harness with injected failures.                    |

The TypeScript command was:

```sh
node frontend/node_modules/typescript/bin/tsc --noEmit --strict \
  --target ESNext --module ESNext --moduleResolution bundler \
  --allowSyntheticDefaultImports --skipLibCheck --types node \
  --typeRoots frontend/node_modules/@types frontend/sync-client/src/index.ts
```

Behavior exercised:

| Scenario                                                                    | Observed result                                                                                                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 24 concurrent content creations, then 12 competing file manifest CAS submissions | Exactly one file manifest winner; committed event IDs remained contiguous.                                                                                    |
| WebSocket origin delivery and reconnect replay                              | Events arrived in increasing order, including events from the connecting device.                                                                         |
| Duplicate JSON UUID keys and invalid portable file manifests                     | Rejected without creating events. Cases included duplicate/alias paths, ancestor conflicts, traversal, reserved names, and directory-spelling conflicts. |
| Content and file manifest receipt retry after a server restart and later heads   | Returned the original acknowledgement without an additional event.                                                                                       |
| Creation and download; online rename sequence and remote swap               | Identities and bytes converged correctly.                                                                                                                |
| Concurrent text changes; first-sync same-path text                          | Both sides' text changes were retained in the checked examples.                                                                                          |
| Concurrent same-path creations                                              | Both UUIDs survived with distinct paths.                                                                                                                 |
| Lost content acknowledgement followed by client restart                     | The original request was recovered, with only one accepted content event.                                                                                |
| Lost file manifest acknowledgement followed by client restart                    | The original file manifest outcome was recovered without a duplicate mutation.                                                                                |
| 22 injected filesystem interruption positions during staged swaps           | Recovery produced the expected files without an unfinished application journal.                                                                          |
| 18 injected metadata-save interruption positions during content replacement | Recovery installed the result without merging it a second time.                                                                                          |
| Unexpected destination file and blocking ancestor file                      | Incoming and unexpected content were both preserved.                                                                                                     |
| Binary conflict and remote delete versus unsent local edit                  | Larger originating mtime won; downloaded mtime was retained; deleted edited bytes remained in recovery.                                                  |
| Ignored remote file, then re-enabled syncing                                | Membership was preserved and the file downloaded once eligible.                                                                                          |
| Save persisted and then reported failure                                    | Reloading durable state allowed retry without restarting the process or duplicating a content mutation.                                                  |
| Initial ping offline, then network recovery                                 | The next attempt progressed rather than reusing a permanently rejected ping promise.                                                                     |
| Move and new file at the old path during a remote fetch                     | The moved document received the merge and the independent new file remained separate.                                                                    |
| Notified delete/recreate with identical bytes at the same path              | A new UUID was allocated.                                                                                                                                |
| UTF-8 BOM and CRLF during text merging                                      | Both were preserved in the checked merge.                                                                                                                |

The temporary harnesses were `/tmp/vault-link-engine-check.ts` and
`/tmp/vault-link-server-check.mjs`. They were deliberately not added to the
repository's testing setup. They used a temporary local server on port 18749;
that server was stopped after validation. Their absolute imports and temporary
configuration are development artifacts, not a portable test runner. Additional
server-restart receipt checks were performed during the session.

The 40 interruption positions are simulated failure points in adapters with the
required atomic semantics. They do not establish durability of real filesystem
adapters, all operating systems, all external-write schedules, or physical storage.

In the delivered rewrite, the old `put_file_content/tests.rs` file was not ported,
and the rewritten handler no longer included its old test module. Subsequent
edits to those files during this handover are separate work. Removed old helper
modules also contained
legacy unit tests. Client fixtures still target the earlier interfaces. The
webpack loader now checks files reachable from production entrypoints so those
unmigrated fixtures do not block building the library. Full legacy-suite and
repository-wide lint success were not claimed.

## Complete file inventory

Every implementation file added, changed, or removed relative to the baseline is
listed below, including regenerated type files and incidental cleanup. Deletions
are listed separately from additions even where Git's similarity detection calls
them renames. Generated binding formatting changes have no additional runtime
meaning unless stated.

This inventory accounts for **85 implementation paths**. It excludes the preexisting `CLAUDE.md` deletion and includes the old/new sides of Git-detected renames separately.

### Server

| File                                                                                                                                                     | Change  | What changed and why                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [sync-server/Cargo.toml](sync-server/Cargo.toml)                                                                                                         | Changed | Declare `sha2` and `unicode-normalization`, remove `sanitize-filename`, and enable ts-rs `no-serde-warnings`. The new mutation code needs request fingerprints and portable-name normalization; server-side filename repair was removed. The preexisting push code already referred to SHA-256; the direct dependency is now declared. |
| [sync-server/Cargo.lock](sync-server/Cargo.lock)                                                                                                         | Changed | Record the matching dependency graph: direct SHA-256/normalization dependencies and removal of the filename-sanitizer package. Keeps builds reproducible for the changed file manifest.                                                                                                                                                     |
| [sync-server/README.md](sync-server/README.md)                                                                                                           | Changed | Replace v3 push/reset instructions with v4 requests, routes, portable-path rules, ordering, recovery, and fresh-state requirements. Documents the actual breaking protocol without suggesting destructive reset commands.                                                                                                              |
| [sync-server/src/consts.rs](sync-server/src/consts.rs)                                                                                                   | Changed | Raise the supported API from 3 to 4 so incompatible clients fail the version check.                                                                                                                                                                                                                                                    |
| [sync-server/src/app_state/database.rs](sync-server/src/app_state/database.rs)                                                                           | Changed | Wire the consolidated read/write modules, use SQLx `begin_with("BEGIN IMMEDIATE")`, and add explicit SQLite and directory-flush durability settings. Keep commit ordering and persistence in the database boundary.                                                                                                                        |
| [sync-server/src/app_state/database/migrations/20241207143519_bootstrap.sql](sync-server/src/app_state/database/migrations/20241207143519_bootstrap.sql) | Changed | Replace the bootstrap schema with events, content-only versions, file manifests, and complete request receipts. Separate membership from bytes and atomically order both. Requires fresh databases; later local edits to this file are outside the earlier validation.                                                                      |
| [sync-server/src/app_state/database/models.rs](sync-server/src/app_state/database/models.rs)                                                             | Changed | Remove path/deletion from content models; add originating mtime, SQLx row decoding, file manifest, event, batch, and vault snapshot types. Flatten wire metadata and use JS-number-compatible exported IDs to express the v4 protocol.                                                                                                      |
| [sync-server/src/app_state/database/mutations.rs](sync-server/src/app_state/database/mutations.rs)                                                       | Added   | Add both CAS transactions, request fingerprint/receipt handling, validation, event allocation, immutable insertions, and post-commit wakeups. Ensures state, order, and retry outcomes commit together.                                                                                                                                |
| [sync-server/src/app_state/database/queries.rs](sync-server/src/app_state/database/queries.rs)                                                           | Added   | Add/consolidate current and immutable content reads, current file manifest, consistent bootstrap vault snapshot, and full ordered event replay. Readers no longer infer membership or event history from latest document rows.                                                                                                              |
| `sync-server/src/app_state/database/get_document_version.rs`                                                                                             | Removed | Remove the separate old-schema query; immutable content reads are retained in `queries.rs` with the new row shape.                                                                                                                                                                                                                     |
| `sync-server/src/app_state/database/get_latest_document.rs`                                                                                              | Removed | Remove the separate old-schema query; current-head reads are retained in `queries.rs` and can share the CAS transaction.                                                                                                                                                                                                               |
| `sync-server/src/app_state/database/get_latest_document_by_path.rs`                                                                                      | Removed | Remove path-based document lookup because content versions no longer own names.                                                                                                                                                                                                                                                        |
| `sync-server/src/app_state/database/get_latest_documents.rs`                                                                                             | Removed | Remove the latest-document listing helper; file manifest membership and a consistent `/vault-snapshot` now define the visible vault.                                                                                                                                                                                                        |
| `sync-server/src/app_state/database/get_latest_documents_since.rs`                                                                                       | Removed | Remove head-only catch-up; replay every durable event so intervening namespace changes are not omitted.                                                                                                                                                                                                                                |
| `sync-server/src/app_state/database/get_max_update_id_in_vault.rs`                                                                                       | Removed | Remove document-table maximum-ID allocation; the common event table allocates IDs for both mutation kinds.                                                                                                                                                                                                                             |
| `sync-server/src/app_state/database/get_push_acknowledgement.rs`                                                                                         | Removed | Remove the content-specific acknowledgement lookup; shared request receipts now return the original response for either CAS kind.                                                                                                                                                                                                      |
| `sync-server/src/app_state/database/insert_document_version.rs`                                                                                          | Removed | Remove the old coupled content/path insertion and direct broadcast. `mutations.rs` now commits state/event/receipt and publishes only a wake hint.                                                                                                                                                                                     |
| [sync-server/src/app_state/websocket/broadcasts.rs](sync-server/src/app_state/websocket/broadcasts.rs)                                                   | Changed | Replace wire-event broadcasts with `VaultUpdate` and ephemeral cursor notifications; make channel capacity at least one. Database replay carries correctness when receivers lag or no subscriber exists.                                                                                                                               |
| [sync-server/src/app_state/websocket/models.rs](sync-server/src/app_state/websocket/models.rs)                                                           | Changed | Replace `VaultUpdate` with `VaultEvents(EventBatch)` and remove the origin-filtering wrapper. Durable event batches can represent both mutations without holes for the originating device.                                                                                                                                             |
| [sync-server/src/app_state/websocket/utils.rs](sync-server/src/app_state/websocket/utils.rs)                                                             | Changed | Remove `get_unseen_documents`; retain handshake authentication and message sending. Catch-up belongs to the durable event query instead of latest-head selection.                                                                                                                                                                      |
| [sync-server/src/app_state/cursors.rs](sync-server/src/app_state/cursors.rs)                                                                             | Changed | Send cursor expiry/update broadcasts through the new ephemeral notification type. Preserve presence behavior independently of persistent event sequencing.                                                                                                                                                                             |
| [sync-server/src/server.rs](sync-server/src/server.rs)                                                                                                   | Changed | Expose request/response modules within the crate for database mutations, add file-manifest/vault-snapshot/events routes, and remove the collection document-list route. Route ownership now reflects the two independent CAS resources.                                                                                                              |
| [sync-server/src/server/endpoints.rs](sync-server/src/server/endpoints.rs)                                                                               | Changed | Register the new file manifest endpoint module and remove the old latest-document-list module so the compiled route set matches v4.                                                                                                                                                                                                         |
| `sync-server/src/server/endpoints/get_file_manifest.rs`, `put_file_manifest.rs`, `vault_snapshot.rs`, and `events.rs`                                    | Added   | Implement file manifest read/CAS, a consistent vault snapshot, and event replay with cursor checks. Supplies the namespace and recovery endpoints.                                                                                                                                                                                          |
| [sync-server/src/server/endpoints/put_file_content.rs](sync-server/src/server/endpoints/put_file_content.rs)                                                   | Changed | Reduce the handler to extraction/auth-context forwarding and content CAS delegation. Remove path/delete decisions and the old v3 test-module inclusion; tests need porting separately.                                                                                                                                                 |
| `sync-server/src/server/endpoints/fetch_latest_documents.rs`                                                                                             | Removed | Remove the old collection endpoint; it cannot express file manifest membership plus a consistent event watermark.                                                                                                                                                                                                                           |
| [sync-server/src/server/endpoints/websocket.rs](sync-server/src/server/endpoints/websocket.rs)                                                           | Changed | Use one ordered sender draining database history, replay from the handshake cursor, poll every two seconds, tolerate lag, and process ephemeral cursors in the same connection loop. Notification timing no longer determines event order.                                                                                             |
| [sync-server/src/server/requests.rs](sync-server/src/server/requests.rs)                                                                                 | Changed | Make pushes content-only, add `PushFileManifest`, deny unknown request fields, and reject duplicate parsed UUID keys. Prevent silent interpretation of legacy payloads or ambiguous maps.                                                                                                                                                  |
| [sync-server/src/server/responses.rs](sync-server/src/server/responses.rs)                                                                               | Changed | Add file manifest `Accepted`/`StaleBase` responses and deserialize support for stored acknowledgements. Enables exact receipt replay for both mutation kinds.                                                                                                                                                                               |
| [sync-server/src/utils/portable_path.rs](sync-server/src/utils/portable_path.rs)                                                                         | Added   | Add namespace-wide portable-path validation and shared comparison conventions. Reject aliases, reserved names, duplicate destinations, and file/ancestor conflicts before canonical acceptance.                                                                                                                                        |
| [sync-server/src/utils.rs](sync-server/src/utils.rs)                                                                                                     | Changed | Register portable validation and remove old sanitizer/path-allocation module exports. Keep naming policy on the client.                                                                                                                                                                                                                |
| `sync-server/src/utils/dedup_paths.rs`                                                                                                                   | Removed | Remove the old path-deduplication helper and its embedded legacy tests. Canonical conflicts now require a valid client-submitted file manifest, not a server-generated alternate view.                                                                                                                                                      |
| `sync-server/src/utils/find_first_available_path.rs`                                                                                                     | Removed | Remove server-side available-name allocation so accepted state equals the submitted file manifest.                                                                                                                                                                                                                                          |
| `sync-server/src/utils/sanitize_path.rs`                                                                                                                 | Removed | Remove server-side path rewriting and its embedded tests. Invalid paths are rejected; client repair is explicit before CAS.                                                                                                                                                                                                            |
| [sync-server/src/errors.rs](sync-server/src/errors.rs)                                                                                                   | Changed | Remove an unused `log::error` import. Compile cleanup only; error semantics were not changed here.                                                                                                                                                                                                                                     |

### Client core and build

| File                                                                                                                                   | Change  | What changed and why                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [frontend/sync-client/README.md](frontend/sync-client/README.md)                                                                       | Added   | Add state/merge policy, notification semantics, recovery layout, adapter requirements, and compatibility boundaries. Gives integrators the contract needed to make the core guarantees meaningful.                                                                                                                                 |
| [frontend/sync-client/src/consts.ts](frontend/sync-client/src/consts.ts)                                                               | Changed | Raise the supported API from 2 to 4 so the rewritten client agrees with the server and rejects incompatible versions.                                                                                                                                                                                                              |
| [frontend/sync-client/src/index.ts](frontend/sync-client/src/index.ts)                                                                 | Changed | Export `FileSnapshot` and new file-manifest/event/request types alongside the retained client surface. Consumers can implement the new adapters and use the v4 protocol types.                                                                                                                                                          |
| [frontend/sync-client/src/persistence/database.ts](frontend/sync-client/src/persistence/database.ts)                                   | Changed | Replace mutable per-file scheduling records with v4 engine state, pending snapshots/responses, deferred remote heads, and application journals. Save before publishing memory state, reload uncertain outcomes, bind state to a vault, and retain cursor-compatible read-only views.                                               |
| [frontend/sync-client/src/persistence/persistence.ts](frontend/sync-client/src/persistence/persistence.ts)                             | Changed | Require an atomic durable complete-state save contract. Recovery needs to know that a successful save survives interruption.                                                                                                                                                                                                      |
| [frontend/sync-client/src/persistence/settings.ts](frontend/sync-client/src/persistence/settings.ts)                                   | Changed | Persist settings before updating memory/listeners and return copies including the ignore-pattern array. Settings saves are assumed to succeed; caller mutation must not silently change the live configuration.                                                                                                                                           |
| [frontend/sync-client/src/file-operations/filesystem-operations.ts](frontend/sync-client/src/file-operations/filesystem-operations.ts) | Changed | Replace the weaker read/overwrite/text-update interface with coherent snapshots, explicit stat, exclusive durable writes, no-replace durable moves, and directory-only pruning. State the no-link and flush requirements needed for recovery.                                                                |
| [frontend/sync-client/src/file-operations/file-operations.ts](frontend/sync-client/src/file-operations/file-operations.ts)             | Changed | Replace direct operations and line-ending conversion with journaled staged application, recovery phases, persisted prepared output, race reconciliation, unexpected-occupant preservation, completed-artifact cleanup, and empty-directory pruning. Makes multi-file namespace changes recoverable without permanent per-application archives. |
| `frontend/sync-client/src/file-operations/safe-filesystem-operations.ts`                                                               | Removed | Remove the in-memory filesystem safety/locking wrapper. Its guarantees cannot substitute for durable journaling and the stronger adapter contract.                                                                                                                                                                                 |
| [frontend/sync-client/src/services/protocol.ts](frontend/sync-client/src/services/protocol.ts)                                         | Added   | Add a single import surface over Rust-generated v4 types plus `FileManifestEntries`. Avoid maintaining a second handwritten protocol definition.                                                                                                                                                                                       |
| [frontend/sync-client/src/services/server-config.ts](frontend/sync-client/src/services/server-config.ts)                               | Changed | Clear a rejected cached ping promise. An initial offline attempt must be able to fetch configuration again.                                                                                                                                                                                                                        |
| [frontend/sync-client/src/services/sync-service.ts](frontend/sync-client/src/services/sync-service.ts)                                 | Changed | Replace legacy multipart/create/text/binary/delete methods and retry builders with typed v4 CAS, vault-snapshot, and replay requests; use `Device-Id`, request timeouts, and permanent/auth/transient error distinctions. The persisted actor owns retries.                                                                        |
| [frontend/sync-client/src/services/websocket-manager.ts](frontend/sync-client/src/services/websocket-manager.ts)                       | Changed | Parse `vaultEvents` as `EventBatch` and notify the actor. Keep existing transport/cursor support while switching the payload shape.                                                                                                                                                                                                |
| [frontend/sync-client/src/sync-client.ts](frontend/sync-client/src/sync-client.ts)                                                     | Changed | Rewire the public client around one durable actor; enforce adapter contracts, serialize persistence, preserve state on reset, restrict vault changes, and keep cursor/history/telemetry integration. Notifications enqueue work and explicit waiting reports completion/failure.                                 |
| [frontend/sync-client/src/sync-operations/content.ts](frontend/sync-client/src/sync-operations/content.ts)                             | Added   | Add stored snapshot conversion and client-only three-way content merging, originating-mtime binary decisions, cursor transformation, BOM handling, and exact-byte/unchanged-side fast paths. Centralizes the content policy used by normal sync and recovery.                                                                      |
| [frontend/sync-client/src/sync-operations/file-manifest.ts](frontend/sync-client/src/sync-operations/file-manifest.ts)                           | Added   | Add per-UUID three-way merge, absence/deletion handling, portable validation, and deterministic cross-ID conflict allocation, including ancestor and oversized-name cases. Produces a valid namespace before CAS and local application.                                                                                            |
| [frontend/sync-client/src/sync-operations/syncer.ts](frontend/sync-client/src/sync-operations/syncer.ts)                               | Changed | Replace concurrent per-document scheduling with the recover/bootstrap/retry/scan/replay/merge/push loop, durable requests, complete scans, identity hints, generation guards, deferred downloads, periodic wakeups, and accepted-snapshot base tracking. Makes namespace and content decisions share one consistent state machine. |
| `frontend/sync-client/src/sync-operations/unrestricted-syncer.ts`                                                                      | Removed | Remove the old second scheduling/operation layer, server-merge response assumptions, and cache-driven update flow. Keeping it beside the new actor would preserve conflicting ownership and v2 behavior.                                                                                                                           |
| [frontend/sync-client/src/sync-operations/cursor-tracker.ts](frontend/sync-client/src/sync-operations/cursor-tracker.ts)               | Changed | Await SHA-256 comparisons, match remote cursors by UUID, display current local paths, and treat missing reads as prior cursor data. Renames must not attach cursors to another document at the old path.                                                                                                                           |
| `frontend/sync-client/src/utils/find-matching-file.ts`                                                                                 | Removed | Remove the old standalone matching helper. Conservative unique-hash identity inference now lives in the actor with complete scan context.                                                                                                                                                                                          |
| [frontend/sync-client/src/utils/hash.ts](frontend/sync-client/src/utils/hash.ts)                                                       | Changed | Replace the 32-bit rolling checksum with async Web Crypto SHA-256 and its known empty digest. Reduce false unchanged/rename decisions from checksum collisions.                                                                                                                                                                    |
| [frontend/sync-client/src/utils/set-up-telemetry.ts](frontend/sync-client/src/utils/set-up-telemetry.ts)                               | Changed | Declare the webpack-injected version constant and guard it with a development fallback. Direct source imports used by consumers/validation must not throw before synchronization starts.                                                                                                                                           |
| [frontend/sync-client/webpack.config.js](frontend/sync-client/webpack.config.js)                                                       | Changed | Set ts-loader `onlyCompileBundledFiles: true`. Production browser/Node builds typecheck their dependency graph without pulling in unmigrated legacy fixtures; this is not a claim those fixtures pass.                                                                                                                             |

### Client generated bindings

| File                                                                                                                                                 | Change  | What changed and why                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [frontend/sync-client/src/services/types/ClientCursors.ts](frontend/sync-client/src/services/types/ClientCursors.ts)                                 | Changed | Regenerate the existing cursor payload as a type alias with generated array syntax. Keeps generated output current; no intended wire change.                                            |
| [frontend/sync-client/src/services/types/CursorPositionFromClient.ts](frontend/sync-client/src/services/types/CursorPositionFromClient.ts)           | Changed | Regenerate the existing cursor payload. Type-alias/array formatting only; the ephemeral wire shape remains the same.                                                                    |
| [frontend/sync-client/src/services/types/CursorPositionFromServer.ts](frontend/sync-client/src/services/types/CursorPositionFromServer.ts)           | Changed | Regenerate the existing cursor response. Formatting/type-alias change only.                                                                                                             |
| [frontend/sync-client/src/services/types/CursorSpan.ts](frontend/sync-client/src/services/types/CursorSpan.ts)                                       | Changed | Regenerate the start/end span definition. Formatting/type-alias change only.                                                                                                            |
| [frontend/sync-client/src/services/types/DocumentWithCursors.ts](frontend/sync-client/src/services/types/DocumentWithCursors.ts)                     | Changed | Regenerate the existing document/cursor descriptor from Rust. Preserve its existing wire field names while aligning generated representation.                                           |
| [frontend/sync-client/src/services/types/WebSocketHandshake.ts](frontend/sync-client/src/services/types/WebSocketHandshake.ts)                       | Changed | Regenerate the token/device/cursor handshake. The replay cursor field is retained; representation changes from interface to type alias.                                                 |
| [frontend/sync-client/src/services/types/PingResponse.ts](frontend/sync-client/src/services/types/PingResponse.ts)                                   | Changed | Regenerate current server configuration metadata, including supported API version. No additional ping endpoint behavior is introduced by the generated-file change.                     |
| [frontend/sync-client/src/services/types/SerializedError.ts](frontend/sync-client/src/services/types/SerializedError.ts)                             | Changed | Regenerate the existing error shape. Formatting/type-alias/array syntax changes only.                                                                                                   |
| [frontend/sync-client/src/services/types/DocumentUpdateResponse.ts](frontend/sync-client/src/services/types/DocumentUpdateResponse.ts)               | Changed | Replace obsolete client `FastForwardUpdate`/`MergingUpdate` variants with `Accepted`/`StaleBase`. Align the client with CAS outcomes already introduced server-side and retained in v4. |
| [frontend/sync-client/src/services/types/DocumentVersion.ts](frontend/sync-client/src/services/types/DocumentVersion.ts)                             | Changed | Regenerate content bytes plus flattened v4 metadata: originating mtime and content size, without path/deletion. Matches the new content-only read/stale response.                       |
| [frontend/sync-client/src/services/types/DocumentVersionWithoutContent.ts](frontend/sync-client/src/services/types/DocumentVersionWithoutContent.ts) | Changed | Regenerate v4 content metadata with mtime and without namespace fields. Used by events, acknowledgements, and bootstrap heads.                                                          |
| [frontend/sync-client/src/services/types/PushContent.ts](frontend/sync-client/src/services/types/PushContent.ts)                                     | Added   | Add generated `Snapshot`/`Diff` transport payloads. No delete operation is allowed in the content resource.                                                                             |
| [frontend/sync-client/src/services/types/PutFileContent.ts](frontend/sync-client/src/services/types/PutFileContent.ts)                                   | Added   | Add generated request ID, nullable content parent, mtime, and content payload. Makes exact content retry data typed.                                                                    |
| [frontend/sync-client/src/services/types/PushFileManifest.ts](frontend/sync-client/src/services/types/PushFileManifest.ts)                                   | Added   | Add generated request ID, file manifest parent, and UUID-to-path map. Makes exact namespace retry data typed.                                                                                |
| [frontend/sync-client/src/services/types/FileManifest.ts](frontend/sync-client/src/services/types/FileManifest.ts)                                           | Added   | Add generated file manifest ID and entries map. Namespace versions are independent of document versions.                                                                                     |
| [frontend/sync-client/src/services/types/FileManifestUpdateResponse.ts](frontend/sync-client/src/services/types/FileManifestUpdateResponse.ts)                       | Added   | Add generated file manifest acceptance/stale variants. The client needs the canonical map when rebasing.                                                                                     |
| [frontend/sync-client/src/services/types/VaultEvent.ts](frontend/sync-client/src/services/types/VaultEvent.ts)                                       | Added   | Add generated content-or-file-manifest event union. Both mutation kinds participate in one sequence.                                                                                         |
| [frontend/sync-client/src/services/types/EventRecord.ts](frontend/sync-client/src/services/types/EventRecord.ts)                                     | Added   | Add generated event/request IDs and flattened event payload. Supports ordered replay and tracing of accepted operations.                                                                |
| [frontend/sync-client/src/services/types/EventBatch.ts](frontend/sync-client/src/services/types/EventBatch.ts)                                       | Added   | Add generated events and head watermark. Lets the client check complete, contiguous replay.                                                                                             |
| [frontend/sync-client/src/services/types/VaultSnapshot.ts](frontend/sync-client/src/services/types/VaultSnapshot.ts)                                 | Added   | Add the generated consistent file-manifest/content-head/watermark vault snapshot. Makes initial bootstrap independent of lossy notifications.                                                     |
| [frontend/sync-client/src/services/types/WebSocketServerMessage.ts](frontend/sync-client/src/services/types/WebSocketServerMessage.ts)               | Changed | Replace `vaultUpdate` with `vaultEvents` while retaining cursor positions. Matches the ordered server stream.                                                                           |
| `frontend/sync-client/src/services/types/CreateDocumentVersion.ts`                                                                                   | Removed | Remove the old optional-server-ID multipart/create request type. V4 creation is client-UUID content CAS followed by file manifest CAS.                                                       |
| `frontend/sync-client/src/services/types/DeleteDocumentVersion.ts`                                                                                   | Removed | Remove the old content deletion payload type. Deletion is absence from the submitted file manifest.                                                                                          |
| `frontend/sync-client/src/services/types/UpdateDocumentVersion.ts`                                                                                   | Removed | Remove the legacy content/path update type. V4 uses `PutFileContent` and independent namespace CAS.                                                                                       |
| `frontend/sync-client/src/services/types/UpdateTextDocumentVersion.ts`                                                                               | Removed | Remove the old text-specific path/update request. Text merges locally and uses the same content CAS transport.                                                                          |
| `frontend/sync-client/src/services/types/FetchLatestDocumentsResponse.ts`                                                                            | Removed | Remove the old document-list response type. Membership/bootstrap/replay use file manifests, snapshots, and event batches.                                                                    |
| `frontend/sync-client/src/services/types/WebSocketVaultUpdate.ts`                                                                                    | Removed | Remove the latest-documents/initial-sync update type. Ordered batches and a separate bootstrap vault snapshot replace its two roles.                                                    |


## Maintainer reading order

For the protocol, read [the server README](sync-server/README.md), then server
`requests.rs`, `models.rs`, `mutations.rs`, `queries.rs`, and the WebSocket handler.
For the client, read [the client README](frontend/sync-client/README.md), then
`persistence/database.ts`, `sync-operations/file-manifest.ts`, `sync-operations/syncer.ts`,
and `file-operations/file-operations.ts`. The adapter interface is part of the
correctness argument and should be read before implementing an integration.

Keep the distinction between a current file manifest version and the event watermark,
and between an accepted sent snapshot and today's disk contents, explicit in any
future change. Those distinctions are central to avoiding skipped namespace
changes and duplicated merges after a lost acknowledgement.
