# Sync client (API v5)

The engine uses one serialized loop per vault and requires Web Crypto (SHA-256). Local notifications and WebSocket
`vaultChanged` hints wake it; complete disk scans and the durable server event log are the
sources of truth. Periodic reconciliation is opt-in: set `syncIntervalMs` to a
positive interval to repair missed notifications. Unset or `0` disables polling.
Create, delete and move notifications persist logical identity changes before
resolving, including while offline. Shutdown waits for those saves. Content-update
notifications only wake reconciliation; scans read the latest bytes, including after
restart. Notifications describe logical external changes: adapters suppress
self-generated create/delete/move notifications, and report atomic editor saves
as content updates. This distinguishes a deliberate delete/recreate from an edit.
Use `waitUntilFinished()` to await the active attempt; errors leave
pending requests saved and are reported to the caller. Transient failures retry;
authentication and protocol errors wait for an explicit wake or settings change.
Pausing or destroying the client aborts its HTTP session, including body reads;
resuming starts a fresh session. Connection checks can run while sync is disabled.

## State and policy

The persisted state contains the incorporated server file manifest, the current
local identity map, and the exact pending submission. A received server file
manifest becomes the merge base when its application metadata is saved. Successful
submissions advance the base to the submitted content snapshot, preserving later
local edits. Unknown outcomes are retried unchanged before incorporating newer
remote state. HTTP is the sole source of remote events; WebSocket messages only
wake the loop. Contiguous event pages are folded in memory into their final manifest
and content heads before merging. An interrupted fetch restarts from the last
incorporated cursor; pagination progress is not persisted. Intermediate changes
that the server has already reverted must not overwrite local edits.

A permanent upload rejection is recorded in metadata. An unchanged rejected payload is skipped so other files can sync; the
failure remains visible in history and `waitUntilFinished()`. Editing it, resetting
the client, or changing settings permits a fresh attempt. Earlier attempts that
committed despite a lost reply are incorporated through normal event replay.

For each document ID (absence means deletion), use the server path if local is
unchanged, use local if the server is unchanged, and use the server when both
changed. Then resolve cross-document path conflicts: a retained server path wins,
UUID ordering breaks other ties, and displaced documents receive deterministic
`(conflict UUID)` names. This also handles file/ancestor and portable-name aliases.
Nonportable local names are repaired client-side before a file manifest is published.
Allocated filename components fit within 255 UTF-8 bytes, including conflict suffixes.
The protocol does not impose a universal total-path byte limit; filesystem-specific
limits surface from the adapter instead of silently flattening a name. Directories
are implicit; empty directories are not synced.

- Content is uploaded before new membership; the client chooses and persists UUIDs.
- Text uses three-way `reconcile`. First contact at a matching path adopts the
  remote ID and reconciles differing text with an empty parent.
- Concurrent binary/unmergeable edits keep the server version. If only one side
  changed, keep that side. No local backup archive is created.
- Deletion follows the file manifest decision, including when the file has local edits.
- Notified moves preserve IDs. Offline inference requires a unique nonempty hash
  match on both sides; uncertain cases become delete/create.
- Ignored and oversized files preserve their disk paths and remote membership.
  The original manifest base is retained while excluded, so becoming eligible
  resumes reconciliation without losing local renames. Not-yet-downloaded files
  are not mistaken for local deletions.
- Bytes and line endings are preserved. File modification times are not tracked
  or synchronized. Optional editor cursors are repositioned when text is reconciled.

## Restored server histories

Successful HTTP responses carry an `X-Vault-Link-History` checkpoint. The client
persists it before consuming the response and supplies it on subsequent reads and
writes. WebSocket events wake HTTP replay, which validates that checkpoint. A
restored database cannot silently reuse a version number: a missing or different
event incarnation returns a history mismatch before executing the request.

On mismatch the client scans local work and records a reset before clearing the
old checkpoint. It clears old requests, receipts, cursors, bases and diff-cache
entries. Clean files reconcile against the restored snapshot. Unsent edits with
an old base become separate local documents; path conflicts preserve them under
conflict names instead of applying a diff to an unrelated restored version.
Recovery resumes after interrupted state saves. Existing API v4 client state
without a checkpoint takes this same conservative bootstrap on upgrade.

Status observers cannot stop the background engine by throwing or rejecting.
Their failures are reported, and remaining observers continue receiving updates.

## Required adapter contract

`FileSystemOperations` and `PersistenceProvider` define the adapter operations.
The Obsidian and CLI adapters still need to adopt the current core interface.
The sync client does not coordinate separate processes accessing the same vault.

The filesystem adapter must provide complete scans, coherent snapshots, recursive
directory creation, exclusive file creation, no-replace renames, and deletion of
individual regular files. Directory pruning uses only `rmdir`, never recursive
file removal. Reject links, special files and paths escaping the vault. An unreadable
file or directory must fail the scan rather than look like a deletion. Optional
editor cursor metadata is applied with file content.

User-file writes have no power-loss durability requirement. There is no filesystem
journal, hidden staging area, replay, backup archive, or flush protocol. Swaps and
cycles temporarily move occupied files to visible conflict names; a fresh scan
can discover them if application stops partway through. Partial writes and edits
made before, during or after an interruption are treated as current disk content.
The next sync reconciles that content; it does not finish a saved filesystem plan.
Power loss may lose bytes or rename identity and may cause a merge to run again.

Metadata is the one atomic boundary: persistence `save` replaces a complete value
and an interrupted/failed save leaves an old or new complete value, never a torn
object. A failed save is reloaded before retrying. No ordering between metadata and
user-file durability is required. Settings and engine saves are serialized.
Keep metadata outside the user-file namespace or in `.vault-link-sync`, which is
excluded from scans. Changing a client's vault once it holds identities, offline
notifications, pending requests or bootstrap state requires a separate state store.

Filesystem application saves metadata once when it finishes. Namespace changes detected
before mutations invalidate the plan. Changes during application are incorporated
between files using their document identities; the next scan rereads content. Content is reread before
replacement. Unexpected eligible occupants receive visible conflict names;
ignored and oversized occupants stay in place. External writers can still change
files between observations, so these checks do not promise transactional file
contents or perfect identity reconstruction. There is no automated v2/v3 state migration.
