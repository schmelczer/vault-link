# Sync client (API v5)

The engine uses one serialized loop per vault and requires Web Crypto (SHA-256). Local notifications and WebSocket
messages wake it; complete disk scans and the durable server event log are the
sources of truth. Periodic reconciliation is opt-in: set `syncIntervalMs` to a
positive interval to repair missed notifications. Unset or `0` disables polling.
`syncLocallyCreatedFile`, `syncLocallyUpdatedFile`, and `syncLocallyDeletedFile`
durably record logical file changes before resolving, including while offline.
Shutdown waits for those saves. Notifications describe logical external changes: adapters suppress
self-generated create/delete/move notifications, and report atomic editor saves
as content updates. This distinguishes a deliberate delete/recreate from an edit.
Use `waitUntilFinished()` to await the active attempt; errors leave
pending work durable and are reported to the caller. Transient failures retry;
authentication and protocol errors wait for an explicit wake or settings change.

## State and policy

The persisted state contains the incorporated server file manifest, the current
local identity map, and the exact pending submission. A received server file
manifest is not a merge base until its local application is durable. Successful
submissions advance the base to the submitted content snapshot, preserving later
local edits. Unknown outcomes are retried unchanged before incorporating newer
remote state. Each contiguous event batch is folded into its final manifest and
content heads before merging. Intermediate changes that the server has already
reverted must not overwrite local edits.

A permanent upload rejection is recorded locally, with content retained for
recovery. An unchanged rejected payload is skipped so other files can sync; the
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
- Concurrent binary/unmergeable edits keep the server version and retain
  displaced local bytes in recovery. If only one side changed, keep that side.
- Deletion follows the file manifest decision. Displaced edited bytes are retained
  locally, without automatically restoring membership.
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

On mismatch the client first recovers its filesystem journal and scans local
work. It durably records a reset before clearing the old checkpoint, archives
pending content requests, and clears old receipts, cursors, bases and diff-cache
entries. Clean files reconcile against the restored snapshot. Unsent edits with
an old base become separate local documents; path conflicts preserve them under
conflict names instead of applying a diff to an unrelated restored version.
Recovery resumes after interrupted state saves. Existing API v4 client state
without a checkpoint takes this same conservative bootstrap on upgrade.

Status observers cannot stop the background engine by throwing or rejecting.
Their failures are reported, and remaining observers continue receiving updates.

## Required adapter contract

`FileSystemOperations` and `PersistenceProvider` define the adapter operations
needed by the recovery model. The Obsidian and CLI adapters have intentionally
not been updated in this rewrite.

The sync client does not coordinate separate processes accessing the same local
vault.

The filesystem adapter must provide:

- Complete scans and coherent content snapshots. Missing and unreadable must
  be distinguished; reject read races rather than return a partial snapshot.
- Vault-relative operations that reject symlinks, hardlinks, special files, and
  ancestor symlink traversal. Staging and visible files share one filesystem.
- Atomic, complete, exclusive file creation (a crash leaves absent or complete
  bytes, never a partial file) and atomic renames that **never replace** destinations.
  Writes apply optional cursor metadata.
- `flushPaths` flushes existing files and ancestor directories, including parents
  of absent paths. Recovery uses it to complete interrupted rename durability.
- Durable recursive directory creation, and directory pruning using only `rmdir`
  operations (never unlink descendant files). All affected data/directory entries
  must be flushed before a mutation resolves, including intermediate ancestors.

Keep the persistence store outside the user file namespace or inside the reserved
`.vault-link-sync` directory, so writing sync state cannot generate user edits.

Persistence `save` atomically replaces the complete state and resolves only after
its data and directory entry are durable. A failed save may leave either complete
value; the engine reloads before retrying. Settings saves are assumed to succeed
and do not reload after errors. Settings and engine saves are serialized.
Changing a client's vault once it holds identities, offline notifications,
pending requests, or bootstrap/application state requires a separate state store
and client. Lifecycle operations are serialized.

Before changing visible files, the engine persists an application journal. It
stages every affected source before installing destinations, so swaps and cycles
work. Recovery runs before scanning, including while the server is unavailable.
Prepared content is persisted before installation, preventing repeated merges
following a crash. Unexpected occupants are preserved and given conflict names.
Notifications received while staging rebind the actual source identity before
content is merged. Editor saves to a temporarily staged path continue the original
document's journal, including saves racing preparation and installation. Ignored
or oversized occupants are reserved before conflict allocation.

`.vault-link-sync/transactions` contains only active recovery artifacts. Staged
sources and prepared output are removed after every install is durably recorded;
completed journals are not archived. `.vault-link-sync/recovery` retains displaced
original bytes and their document/path metadata before staging files are deleted.
`.vault-link-sync/requests` retains rejected submission snapshots for explicit
recovery. These directories are never scanned
as user files. Pending requests and active recovery journals must not be
independently discarded.

These guarantees assume the adapters/storage honor their durability contracts.
Arbitrary external writers can change a file between observations; detected races
are preserved/reconciled, but unobserved writes and offline identity cannot be
reconstructed perfectly. There is no automated v2/v3 persisted-state migration.
