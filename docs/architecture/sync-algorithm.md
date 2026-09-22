# Sync algorithm

The current API v5 server stores immutable content versions and a separately
versioned file manifest. Clients reconcile snapshots with the current local files. The server does not merge competing edits.

## Identity and ordering

Each document has a UUID independent of its path. A file manifest maps live UUIDs
to paths; removing a mapping deletes membership. Updating content never restores
membership. Directories are implicit.

Every accepted content or manifest update appends an event in the same SQLite
transaction. Event IDs order changes and serve as version IDs. A push names its
parent version and a unique request UUID. The server either accepts that exact
snapshot or returns current metadata as `StaleBase`. Retrying an accepted request
returns its original acknowledgement; changing its payload under the same request
UUID is rejected.

## Reconciliation

A new client reads a coherent vault snapshot, applies it, then replays
subsequent events over HTTP. Pages are folded in memory to their final document
heads and manifest before changing local files. Interrupted fetching restarts from
the last incorporated cursor without saved pagination state. This avoids applying
intermediate remote edits that were already reverted.

For text, the client compares the common base, current local bytes and current
remote bytes using `reconcile-text`. Configured extensions and valid UTF-8 without
NUL bytes determine whether text merging is allowed. Diffs optimize transport;
they do not authorize the server to merge a stale base. Large diff operation sets
are sent as snapshots.

If only one side changed, that side is retained. Concurrent unmergeable changes
keep the server version. First contact with existing local text has no shared ancestor and uses
an empty parent. Concurrent edits may still require human review.

Paths use a separate three-way decision: keep a local change when the server path
is unchanged, otherwise prefer the server path if both changed. Portable-name
collisions receive deterministic conflict names. A manifest deletion is not
reversed merely because another client edited the document. Local backup archives
are not created.

## Filesystem application

The client applies an in-memory plan directly to the visible namespace, then
saves one metadata snapshot. Swaps and cycles move occupied sources to temporary
conflict names that remain ordinary discoverable files if application stops.
There is no persisted filesystem plan, staged payload, recovery replay or fsync
protocol. An interruption may leave a subset of the operations visible, or partial
file content; the next scan reconciles whatever is present then.

Create, delete and move notifications persist logical document identities; content
updates only wake the loop to reread current bytes. Namespace changes detected
before mutations invalidate the plan. Notifications during application are incorporated
between files using their document identities; the next scan rereads content. Content is reread
before replacement. Ignored and oversized occupants stay in place. Adapters
use raw filesystem events only to wake a scan. These include engine writes and
atomic editor replacements, so they must not be reported as logical create/delete
notifications. Integrations with reliable user-action events can persist those
explicit notifications to preserve rename identities, as Obsidian does for
`Vault.rename`. Raw watchers infer a move
only when the missing and new files have a unique matching, nonempty content hash.

Metadata persistence must replace a complete value atomically, leaving a readable
old/new value after interruption. Metadata and user files need not describe the
same moment: scans repair that disagreement. File creation and rename must reject
occupied destinations; scans must be complete and reads coherent. No guarantee is
made that user bytes or rename identities survive power loss.

## Server restores and failures

Numeric version equality cannot establish identity after restoring a backup.
Successful HTTP responses include a checkpoint with an event-incarnation token.
The client persists and echoes it; the server rejects a checkpoint from a discarded
history before executing its request. Each new event gets a fresh token even if
its numeric ID or request UUID was used on the discarded branch.

After a mismatch, the client records reset intent, clears old history-dependent state and bootstraps against the restored
server. Clean files reconcile against the restored snapshot. Unsent edits with an
old base are preserved as separate local documents, with conflict names if needed.
Interrupted recovery saves are replayable. Backups must be restored with the server
stopped.

WebSocket `vaultChanged` hints wake HTTP replay. The server periodically compares
its history checkpoint to detect missed broadcasts; transport liveness checks
recover disconnected clients. Authentication and permanent errors remain visible;
transient errors retry according to client settings. Observer callback failures
are isolated from the background sync loop.

API v5 clients and servers must be deployed together. V4 databases migrate without
removing history. CLI and desktop Obsidian share the Node filesystem adapter and
complete-record metadata persistence. Node file moves use exclusive creation
followed by unlink, so interruption may leave two ordinary files. Metadata alone
is flushed before an atomic rename; there is no user-file durability protocol.
Obsidian mobile uses the host storage API. Its exclusive-copy API requires a
scratch input file in the ignored internal directory; leftovers are never replayed
or used for recovery. Mobile metadata persistence uses Obsidian's data store.
