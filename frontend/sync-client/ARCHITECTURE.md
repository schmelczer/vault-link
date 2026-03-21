# Sync Client Architecture

## Overview

The sync client synchronizes Obsidian vault files between clients via a central server. It handles offline edits, concurrent multi-client changes, crash recovery, and real-time updates via WebSocket.

## Architecture Layers

```
SyncClient (public API — unchanged)
    │
    ├── Syncer (event router + reconciliation orchestrator)
    │       │
    │       ├── SyncEventQueue (per-document coalescing FIFO)
    │       │       │
    │       │       └── executor callback → sync-actions functions
    │       │
    │       └── VirtualFilesystem (document identity + state tracking)
    │
    ├── WebSocketManager (connection, message serialization)
    ├── FileOperations (filesystem abstraction, 3-way merge on write)
    ├── SyncService (HTTP client for server REST API)
    ├── CursorTracker (collaborative cursor positions)
    └── ContentCache (LRU cache for diff computation)
```

## Key Design Decisions

### 1. Sequential Processing

All sync operations run one at a time. No concurrent sync operations, no locks, no deadlock prevention, no generation counters. The server uses SQLite which serializes writes anyway, so client-side parallelism provided no real benefit while creating enormous complexity.

The only concurrency that remains is between the sync queue and the WebSocket message handler, but both funnel events into the same sequential queue.

### 2. Virtual Filesystem (VFS)

Replaces the old `Database` class. Documents have explicit states as a discriminated union:

```typescript
type VirtualDocument =
    | PendingDocument       // Created locally, server doesn't know yet
    | TrackedDocument       // Synced with server
    | DeletedLocallyDocument // Deleted locally, server not yet notified
```

Three internal indexes replace the old flat array + `parallelVersion` system:
- `pathIndex` — at most one live document per path
- `documentIdIndex` — all documents with a server-assigned ID
- `idempotencyKeyIndex` — pending documents only

No more inferring state from `metadata === undefined` + `isDeleted` + `parentVersionId === 0`. The state field is the discriminator.

### 3. Per-Document Event Coalescing

Events from file watchers and WebSocket broadcasts are grouped by document identity and coalesced:
- 10 rapid edits → 1 sync operation (content read at execution time)
- create then delete → noop (file never reached the server)
- move A→B then B→C → move A→C

This replaces the old opaque-closure FIFO where every event was independent.

### 4. Server Protocol Unchanged

The server still does 3-way merging via `reconcile-text`. Response types (`FastForwardUpdate`, `MergingUpdate`) are unchanged. The client content cache remains for diff computation (needed for mobile bandwidth). Idempotency keys remain for crash-safe creates. No server changes were made.

## Module Descriptions

### `persistence/vfs.ts` — Virtual Filesystem

Tracks document identity across creates, moves, deletes. Provides:
- State transitions: `createPending()`, `confirmCreate()`, `assignDocumentId()`, `updateTracked()`, `deleteLocally()`, `confirmDelete()`
- Queries: `getByPath()`, `getByDocumentId()`, `getByIdempotencyKey()`
- Disk reconciliation: `reconcileWithDisk()` returns a pure result comparing VFS state against filesystem
- Persistence: serializes to `StoredDatabase` format (backward compatible)

### `sync-operations/sync-events.ts` — Event Types + Coalescing

Pure functions with no side effects. Defines `SyncEvent` (6 types from file watchers and WebSocket) and `CoalescedAction` (8 possible merged actions). The `coalesce()` function implements a 48-entry transition table.

### `sync-operations/sync-event-queue.ts` — Event Queue

Per-document coalescing FIFO. Maps each event to a document key (documentId for tracked docs, `path:<relativePath>` for pending docs). Processes one document at a time via an injected executor. Supports key migration when pending docs receive a documentId.

On reset (WebSocket disconnect): remote events are cleared (server replays on reconnect), local events are preserved (unsynced user actions).

### `sync-operations/sync-actions.ts` — Sync Action Implementations

Extracted from the old `unrestricted-syncer.ts`. Each function takes explicit dependencies (`SyncDeps`) and a VFS document:

- `executeSyncCreate()` — POST to server with idempotencyKey, handle response
- `executeSyncUpdate()` — compute diff from cache, PUT to server
- `executeSyncDelete()` — DELETE on server, confirm in VFS
- `executeRemoteUpdate()` — download content, write to disk, update VFS
- `applyServerResponse()` — handle MergingUpdate/FastForwardUpdate, path changes, idempotent returns

### `sync-operations/syncer.ts` — Orchestrator

Thin layer that:
- Converts file change events → `SyncEvent` objects → enqueue
- Converts WebSocket broadcasts → `SyncEvent` objects → enqueue
- Sets up the executor that dispatches `CoalescedAction` → sync-actions functions
- Runs offline reconciliation: resolve idempotency keys → scan filesystem → enqueue results
- Manages the `scheduleSyncForOfflineChanges` lifecycle

## Offline Reconciliation Algorithm

Runs on startup and WebSocket reconnect:

1. **Resolve idempotency keys** — call server for pending creates whose responses were lost
2. **Clean up orphans** — remove pending docs whose files no longer exist
3. **Scan filesystem** — `vfs.reconcileWithDisk()` compares VFS state vs actual files
4. **Apply moves** — update VFS for detected file moves (content hash matching)
5. **Enqueue events** in order:
   - Interrupted deletes (VFS says deleted-locally, file gone, server not notified)
   - Moves (detected via hash matching)
   - Updates (file content changed)
   - Creates (new files with no VFS entry)
   - Delete candidates (VFS entry but file missing, not matched as a move)

Creates run before delete candidates so the server can merge creates with existing documents (preserving documentIds).

## Document Lifecycle

```
[File created locally]
    → VFS: createPending(path) → PendingDocument
    → Queue: enqueue local-create
    → Action: POST /documents with idempotencyKey
    → Server: returns FastForwardUpdate or MergingUpdate
    → VFS: confirmCreate() → TrackedDocument

[File edited locally]
    → Queue: enqueue local-update
    → Action: compute diff, PUT /documents/:id/text
    → Server: returns FastForwardUpdate or MergingUpdate
    → VFS: updateTracked()

[File deleted locally]
    → VFS: deleteLocally() → DeletedLocallyDocument (or removed if pending)
    → Queue: enqueue local-delete
    → Action: DELETE /documents/:id
    → VFS: confirmDelete() → removed

[Remote update via WebSocket]
    → Queue: enqueue remote-update
    → Action: fetch content, write to disk
    → VFS: updateTracked()

[Crash during create → restart]
    → VFS loads PendingDocument from disk (idempotencyKey preserved)
    → resolveIdempotencyKeys() maps key → documentId
    → VFS: assignDocumentId() → TrackedDocument with serverVersion=0
    → Queue: enqueue local-create (retry)
    → Server: returns existing document (idempotent)
    → VFS: updateTracked() with real serverVersion
```

## Invariants

1. **All state mutations go through the sequential queue.** No document state can change while a sync operation is running. File-change handlers and WebSocket handlers only enqueue events.

2. **Content cache stores server content after merges.** The cache is used for diff computation: `diff(cached_server_content, new_local_content)`. The server applies diffs against its content at `parentVersionId`.

3. **Idempotency keys survive crashes.** VFS persists pending documents with their keys. On restart, `resolveIdempotencyKeys` maps keys to documentIds. The key is preserved on TrackedDocument when `serverVersion === 0` so retry creates remain idempotent.

4. **Write file before updating metadata.** If the write fails, metadata still points to the old version. On recovery, the stale `serverVersion` triggers a re-fetch from server.

5. **Local events survive reset.** When the WebSocket disconnects, remote events are cleared (server replays on reconnect) but local events are preserved in the queue as unsynced user actions.

6. **Creates run before delete candidates** in the reconciliation ordering. A create may adopt a "deleted" document's identity via server-side merge.

## What Was Removed

- **PQueue** — configurable concurrency queue (replaced by sequential event queue)
- **Locks** — per-document multi-key locks with alphabetical ordering
- **Generation counters** — `resetGeneration` for stale operation detection
- **`containsDocument` guards** — 11 guards after async operations for concurrent-delete protection
- **`parentVersionIdForUpdate` snapshots** — mutable reference protection
- **`parallelVersion`** — collision tracking for multiple docs at same path
- **`UnrestrictedSyncer`** — 1,169-line class with nested if/else (replaced by sync-actions.ts with explicit dispatch)
- **`Database` class usage** — replaced by VFS everywhere (class still exists for type exports)

## Files

```
persistence/
  vfs.ts                    779 lines  — Virtual Filesystem
  database.ts               535 lines  — Type definitions only (StoredDatabase, RelativePath, etc.)

sync-operations/
  syncer.ts                 615 lines  — Orchestrator
  sync-actions.ts          1229 lines  — Action implementations
  sync-event-queue.ts       242 lines  — Per-document coalescing queue
  sync-events.ts            297 lines  — Event types + coalescing logic
  unrestricted-syncer.ts   1169 lines  — DEAD CODE (not imported, to be deleted)
  cursor-tracker.ts         273 lines  — Cursor position tracking
```
