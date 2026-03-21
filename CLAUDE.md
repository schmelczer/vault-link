# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VaultLink is a self-hosted Obsidian plugin for real-time collaborative file syncing. The project consists of a Rust-based sync server and a TypeScript frontend with four main components: an Obsidian plugin, a sync client library, a test client, and a standalone CLI client.

## Architecture

### Core Components

- **sync-server/**: Rust-based WebSocket server with SQLite database for document versioning and real-time synchronization
- **frontend/sync-client/**: TypeScript library providing core sync functionality, WebSocket management, and file operations
- **frontend/obsidian-plugin/**: Obsidian plugin that integrates the sync client with Obsidian's API
- **frontend/test-client/**: CLI testing tool for simulating multiple concurrent users
- **frontend/local-client-cli/**: Standalone CLI for VaultLink sync client
- **frontend/history-ui/**: Svelte 5 web UI for browsing vault history, viewing diffs, and restoring versions

### Key Technologies

- **Backend**: Rust with Axum framework, SQLite with SQLx, WebSockets for real-time sync
- **Frontend**: TypeScript, Webpack for bundling, Node.js native test runner
- **History UI**: Svelte 5 with runes, Vite for bundling, embedded in server binary via `rust-embed`
- **Sync Algorithm**: Uses reconcile-text library for operational transformation

### Architectural Patterns

**Server Architecture:**

- `AppState`: Central state container holding `Database`, `Cursors`, and `Broadcasts`
- `Database`: SQLite-backed document versioning with SQLx for compile-time query verification
- `Broadcasts`: WebSocket broadcast system for real-time updates to connected clients
- `Cursors`: Tracks user cursor positions across documents with background cleanup task

**Client Architecture:**

- `SyncClient`: Main entry point, orchestrates all sync operations
- `SyncService`: HTTP API client for CRUD operations on documents
- `WebSocketManager`: Manages WebSocket connection and real-time updates
- `Syncer`: Coordinates file synchronization between local filesystem and server
- `CursorTracker`: Manages local and remote cursor positions
- `Database`: Client-side document metadata cache
- `FileOperations`: Abstraction layer for filesystem operations

**Dual-Bundle Strategy:**
The sync-client builds two separate bundles:

- `sync-client.web.js`: Browser-compatible UMD bundle (excludes `ws` package)
- `sync-client.node.js`: Node.js CommonJS bundle with WebSocket support

**History UI Architecture:**

The history UI (`frontend/history-ui/`) is a standalone Svelte 5 SPA that provides read-only vault history browsing. It communicates with the server via the same REST API used by sync clients, plus three additional endpoints:

- `GET /vaults/:vault_id/documents/:document_id/versions` — all versions of a document (without content)
- `GET /vaults/:vault_id/history?limit=&before_update_id=` — paginated vault-wide version history (cursor-based)
- `POST /vaults/:vault_id/documents/:document_id/restore` — restore a document to a historical version (creates a new version with old content)

Server-side implementation:
- Database methods: `get_document_versions()` and `get_vault_history()` in `database.rs`, plus a `VaultHistoryRow` helper struct for `sqlx::query_as!`
- Handlers: `fetch_document_versions.rs`, `fetch_vault_history.rs`, `restore_document_version.rs`
- Response type: `VaultHistoryResponse { versions, hasMore }` in `responses.rs`
- SPA serving: `rust-embed` embeds `frontend/history-ui/dist/` into the binary; `index.rs` serves the SPA at `/` and assets at `/assets/*`

Client-side component hierarchy:
- `App.svelte` — session restore, routing
- `Login.svelte` — vault name + token auth via `/ping`
- `Dashboard.svelte` — main layout: file tree sidebar, activity feed, time-travel slider
- `DocumentDetail.svelte` — version timeline, content preview, diff view, restore
- `DiffView.svelte` — unified diff with LCS algorithm
- `FileTree.svelte` — recursive tree built from flat `relativePath` values
- `ActivityFeed.svelte` — git-log-style feed with action pills (created/updated/renamed/deleted/restored)
- `TimeSlider.svelte` — scrubs through `vaultUpdateId` range, reconstructs vault state at any point

State is managed with Svelte 5 runes (`$state`, `$derived`, `$effect`) in `lib/stores.svelte.ts`. Auth is stored in `sessionStorage`. The API client (`lib/api.ts`) sets `Authorization: Bearer` and `device-id: history-ui` headers on all requests.

## Development Commands

### Initial Setup

**Node.js (requires version 25):**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 25
nvm use 25
nvm alias default 25  # Optional: set as system default
```

**Rust:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
cargo install sqlx-cli cargo-machete cargo-edit cargo-insta
```

**Frontend:**

```bash
cd frontend
npm install
```

### Server Development

```bash
cd sync-server
cargo run config-e2e.yml  # Start development server
cargo test --verbose      # Run all Rust tests
cargo test <test_name>    # Run specific test
cargo clippy --all-targets --all-features  # Lint Rust code
cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged  # Auto-fix clippy warnings
cargo fmt --all -- --check  # Check Rust formatting
cargo fmt --all            # Auto-format Rust code
cargo machete --with-metadata  # Detect unused dependencies
```

### Frontend Development

```bash
cd frontend
npm run dev      # Start development mode (watches sync-client and obsidian-plugin)
npm run build    # Build all workspaces
npm run build -w sync-client     # Build specific workspace
npm run test     # Run all tests across all workspaces
npm run test -w sync-client      # Run tests for specific workspace
npm run lint     # Lint and format TypeScript code with ESLint + Prettier
```

### History UI Development

```bash
cd frontend
npm run dev -w history-ui   # Start Vite dev server (localhost:5173, proxies API to localhost:3000)
npm run build -w history-ui  # Build for production (output: frontend/history-ui/dist/)
```

The history UI is a Svelte 5 SPA embedded in the server binary via `rust-embed`. The build flow is:

1. `npm run build -w history-ui` produces `frontend/history-ui/dist/`
2. The Rust server embeds these files at compile time (`sync-server/src/server/index.rs`)
3. The server serves `index.html` at `GET /` and static assets at `GET /assets/*`
4. If the dist directory doesn't exist at Rust compile time, `build.rs` creates a placeholder

During development, run the Vite dev server separately and use its proxy to forward API calls to the running sync server.

### Database Operations

```bash
cd sync-server
# Create/reset database for development
rm -rf db.sqlite*
sqlx database create --database-url sqlite://db.sqlite3
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
cargo sqlx prepare --workspace

# Add new migration
sqlx migrate add --source src/app_state/database/migrations <migration_name>
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
```

### Project Scripts

- `scripts/check.sh`: Full CI check (builds, lints, tests both server and frontend). **Run before pushing.**
- `scripts/check.sh --fix`: Same as above but auto-fixes linting and formatting issues
- `scripts/e2e.sh`: End-to-end testing (e.g., `scripts/e2e.sh 8` for 8 concurrent clients)
- `scripts/clean-up.sh`: Clean logs and database files
- `scripts/bump-version.sh patch`: Publish new version (options: patch, minor, major)
- `scripts/update-api-types.sh`: Update TypeScript bindings from Rust types (uses ts-rs)

## Code Structure

### Workspace Configuration

The frontend uses npm workspaces with five packages:

- `sync-client`: Core synchronization logic (builds dual bundles for web and Node.js)
- `obsidian-plugin`: Obsidian-specific integration
- `test-client`: Testing utilities for E2E tests
- `local-client-cli`: Standalone CLI for VaultLink sync client
- `history-ui`: Svelte 5 SPA for vault history browsing (built with Vite, embedded in server binary)

### Type Generation and API Updates

Rust structs generate TypeScript types via ts-rs crate:

1. Rust structs annotated with `#[derive(TS)]` export to `sync-server/bindings/`
2. Run `scripts/update-api-types.sh` to copy bindings to `frontend/sync-client/src/services/types/`
3. Frontend imports these types for type-safe API communication

### Important Implementation Details

**SQLx Compile-Time Verification:**

- SQLx verifies SQL queries at compile time against the database schema
- Run `cargo sqlx prepare --workspace` after schema changes to update `.sqlx/` directory
- CI builds require prepared query metadata to avoid needing a live database

## Testing

### Running Tests

**Server:**

```bash
cargo test --verbose           # All tests
cargo test <test_name>         # Specific test
```

**Frontend:**

```bash
npm run test                   # All workspaces
npm run test -w sync-client    # Specific workspace
```

**E2E:**

```bash
scripts/e2e.sh 8               # 8 concurrent clients
scripts/clean-up.sh            # Clean up after tests
```

### Test Structure

- **Rust**: Unit tests alongside source files, uses `cargo-insta` for snapshot testing
- **TypeScript**: `.test.ts` files using Node.js native test runner (not Jest)
- **E2E**: Uses `test-client` to simulate multiple concurrent users with random operations

## Code Style and Formatting

### Rust

- Extensive Clippy lints (see `Cargo.toml`)
- Pedantic linting rules enabled
- Forbids unsafe code
- Uses `rustfmt.toml` for formatting configuration (4 spaces, Unix line endings)
- Run `cargo fmt --all` to format

### TypeScript

- **Prettier**: 4-space indentation, no trailing commas, LF line endings
- **YAML/Markdown override**: 2-space indentation (via prettier config)
- **ESLint**: Strict rules with unused imports detection
- Configuration in `frontend/package.json`
- Run `npm run lint` to format and fix issues

### Svelte (History UI)

- Uses Svelte 5 runes syntax (`$state`, `$derived`, `$effect`, `$props`)
- Vite as bundler with `@sveltejs/vite-plugin-svelte`
- Excluded from the main ESLint config (Svelte files need different linting); `history-ui/**` is in the eslint ignores list
- CSS is component-scoped via Svelte's `<style>` blocks with CSS custom properties defined in `app.css`

### EditorConfig

- `.editorconfig` at project root defines baseline formatting rules
- `rustfmt.toml` and Prettier config explicitly mirror these settings
- Both formatters enforce: 4-space indent (2 for YAML/MD), LF endings, final newline, trim trailing whitespace

## Sync Logic Deep Dive

### Document Lifecycle

Documents go through these states on the client:

1. **Pending create**: `metadata === undefined`, `idempotencyKey` set. File exists locally but hasn't been confirmed by the server yet.
2. **Synced**: `metadata` has `documentId`, `parentVersionId`, `hash`. The server knows about this document.
3. **Deleted**: `isDeleted === true`. Locally deleted, may or may not be synced to server yet.

Pending creates are persisted to the local DB (via `StoredPendingDocument`) so they survive app crashes.

### Create Flow and Idempotency

The create flow is designed to handle interrupted creates (lost responses, app crashes):

1. Client generates `idempotencyKey` (UUID) and persists it locally before sending the request
2. Client sends HTTP POST with the key and file content to the server
3. Server checks if the `idempotency_key` already exists — if so, returns existing document (idempotent)
4. Server stores the key in the `documents` table alongside the document version
5. When a create results in a merge (document already exists at that path), both the original key and the new key are preserved — they're on different version rows of the same document

On reconnect, the client calls `POST /documents/resolve-keys` with all pending idempotency keys. The server maps each key to a `documentId`. The client assigns these documentIds to pending documents so they're recognized during subsequent remote fetch, preventing duplicates.

If key resolution fails (e.g., during a SyncReset), the pending creates retry normally with the same key — the server deduplicates.

### Server-Side Smart Create

When a client sends a create request for a path where a document already exists:

1. Server calls `merge_with_stored_version` instead of creating a new document
2. Content is 3-way merged using `reconcile-text` (for text files) or last-write-wins (for binary)
3. The response uses the EXISTING document's `documentId` — the client adopts it
4. The `idempotency_key` from the create request is stored on the new merged version

### Concurrency Model (Client)

The client uses two layers of concurrency control:

1. **PQueue (`syncQueue`)**: Limits concurrent sync operations (configurable via `syncConcurrency`)
2. **Locks (`updatedDocumentsByPathAndKeysLocks`)**: Per-document locks keyed by `relativePath` and `documentId`

**Critical ordering**: Locks are acquired INSIDE the queue, not outside. Acquiring locks while waiting for queue slots causes deadlocks (two operations hold locks on different keys while both waiting for queue capacity).

```
syncQueue.add(async () =>
    locks.withLock(keys, operation)  // lock acquired only when queue slot is available
)
```

### Sync Reset and Recovery

A `SyncResetError` is thrown when the WebSocket disconnects or sync is toggled off. This:
- Clears the sync queue
- Rejects all pending lock waiters
- On reconnect, `scheduleSyncForOfflineChanges()` runs to reconcile local state with server

**Important**: `SyncResetError` during `syncRemotelyUpdatedFile` must be caught and logged as INFO, not ERROR. The test client exits on ERROR-level logs (except retries), so logging SyncResetError as ERROR during expected resets causes false test failures.

### The Offline Sync Algorithm (`scheduleSyncForOfflineChanges`)

Runs on reconnect to detect what changed while offline:

1. **Resolve idempotency keys first**: Call `resolveIdempotencyKeys()` to map pending creates to server-side documentIds before scanning files
2. List all local files
3. For each file with metadata: schedule as update (hash comparison will skip unchanged)
4. For each file without metadata: try to match against "deleted" DB records by content hash (detects moves). If no match, schedule as create.
5. For DB records whose files don't exist locally: schedule as delete
6. Ordering is: interrupted-deletes → updates → creates → possibly-deleted-deletes. Creates run BEFORE possibly-deleted deletes so that the server can merge creates with existing documents at the same path (preserving documentIds). If deletes ran first, a renamed+edited file would get a new documentId instead of adopting the existing one.

### Remote Update Processing

When the server broadcasts updates via WebSocket:

1. `scheduleSyncForOfflineChanges()` runs first (ensures local changes are queued)
2. For each remote document update:
   - If client knows the `documentId`: treat as update to existing doc
   - If client doesn't know the `documentId`: it's a new remote document — create locally
3. Before creating a new local file for an unknown remote doc, check if a pending local create exists at the same `originalCreationPath`. If so, skip (the pending retry with idempotency key will handle it).

### Known Concurrency Pitfalls

1. **Interrupted create + rename + modify**: A create request succeeds on the server but the response is lost. The file is renamed and modified locally. On reconnect, the idempotency key resolution maps the pending doc to the server's documentId, preventing a duplicate.

2. **Two clients create at same path**: Both send creates with different idempotency keys. Server merges them under one `documentId`. Each key is stored on its respective version row. Both clients can resolve their keys to the same document.

3. **Lock ordering**: Multi-key locks are sorted alphabetically to prevent deadlocks. Lock acquisition is sequential (not concurrent) even for multiple keys.

4. **`resolvedDocuments` vs `pendingDocuments`**: `resolvedDocuments` only includes docs with metadata (filters by `metadata !== undefined`). `pendingDocuments` returns docs with `metadata === undefined && !isDeleted`. Never confuse the two — scanning `resolvedDocuments` for pending docs returns nothing.

5. **`saveInTheBackground` triggers `ensureConsistency`**: The consistency check calls `resolvedDocuments` which can throw if there are duplicate paths with the same `parallelVersion`. Avoid calling `saveInTheBackground` during operations that temporarily create inconsistent state — use `save()` directly instead. This is why `createNewPendingDocument` calls `save()` directly.

6. **Pending doc `parallelVersion` on load**: When loading pending documents from storage, compute `parallelVersion` based on existing docs at the same path (use `getLatestDocumentByRelativePath` to find the current max). Setting all to 0 causes collisions if a resolved doc at the same path also has `parallelVersion: 0`.

7. **Key resolution with stale documentIds**: When `resolveIdempotencyKeys` returns a documentId, check `getDocumentByDocumentId` first. If another document already has that ID (assigned through normal sync), remove the stale pending doc instead of creating a duplicate.

8. **`resolveIdempotencyKeys` uses `retryForever`**: The HTTP call to `/documents/resolve-keys` retries forever like all other sync service calls. `SyncResetError` is re-thrown by `retryForever`, so the pipeline properly aborts on WebSocket disconnect without deadlocking.

### E2E Test Configuration

The test client (`frontend/test-client/src/cli.ts`) runs 5 iterations of 9 test configurations per process:
- 2 agents, concurrency 16 and 1, with/without deletes, with/without resets, with/without slow file events
- Tests assert: file system consistency between agents AND no duplicate content across files
- Uses `jitterScaleInSeconds: 0.75` to simulate network latency

**Running E2E**: Requires a server running with `config-e2e.yml`. Always clean the server databases before running. Use `scripts/e2e.sh 8` for 8 concurrent processes (each running the full test suite independently).

**E2E test harness known issue**: The named pipe mechanism for log collection can cause processes to hang when debug output exceeds the pipe buffer size. This is an infrastructure issue, not a sync bug. If processes appear stuck with logs that stopped growing, it's likely a pipe buffer issue.

### File Operations Abstraction

`FileOperations` has an `ensureClearPath` method that renames existing files to `(1).md`, `(2).md` etc. if a file already exists at the target path. This prevents data loss but can create apparent duplicates if the sync logic doesn't handle it.

The `write` method does a 3-way merge: `write(path, oldContent, newContent)`. It reads the current file, computes a diff from `oldContent` to `newContent`, and applies that diff to the current file content. This preserves local changes that happened between the read and write. If the old content doesn't match what's expected, the merge can fail with "Part X not found in new content".

### Approaches That Were Tried and Failed

When fixing the duplicate-document-after-interrupted-create problem, several heuristic approaches were attempted before landing on idempotency keys:

1. **Content-hash matching during remote fetch**: Scan all pending docs, read each file, hash it, and compare against incoming remote document. Failed because: (a) local content can be modified between the create and the fetch, so hashes don't match; (b) O(pending × remote) file I/O; (c) the `resolvedDocuments` getter was used instead of `pendingDocuments`, which filtered out all pending docs — a silent no-op bug.

2. **`originalCreationPath` matching**: Track where each pending doc was originally created. When a remote doc arrives at that path, assign metadata. Failed because: (a) two different clients can create at the same path — false matches assign wrong metadata, causing 3-way merge errors on the other client; (b) adding a `deviceId` check to limit false matches broke the case where another client updated the document (changing the deviceId in the broadcast).

3. **In-memory tracking** (e.g., `pendingLocalId`): Any in-memory state is lost on app crash. The whole point of the fix is to handle interrupted creates, which include crashes.

The idempotency key approach works because it's: (a) crash-safe (persisted locally); (b) deterministic (UUID lookup, no heuristics); (c) server-authoritative (the server resolves keys to documentIds).

### Critical Implementation Invariants (Learned from Bugs)

These invariants were discovered through deep auditing and E2E testing. Violating any of them causes data loss, sync stalls, or test failures.

**1. `waitUntilFinished` must loop until both sync queue AND WebSocket handlers are simultaneously idle.**
WebSocket message handlers (`onRemoteVaultUpdateReceived`) enqueue new sync operations. If you wait for the sync queue first, then WebSocket handlers, the handlers may have enqueued new operations that aren't awaited. The correct implementation loops: wait for WS handlers → wait for sync queue → check if WS has new work → repeat if needed. See `SyncClient.waitUntilFinished()`.

**2. `enqueueSyncOperation` must catch ALL errors, not just `SyncResetError`.**
`executeSync` re-throws non-SyncReset/non-FileNotFound errors (they're logged in sync history as ERROR). If `enqueueSyncOperation` doesn't catch these, they become unhandled promise rejections that crash the process. The catch logs the error and returns undefined — failed operations will be retried on the next WebSocket reconnect (which clears `runningScheduleSyncForOfflineChanges` and triggers a fresh filesystem scan).

**3. `Locks.reset()` must NOT clear `this.locked`.**
In-flight operations (currently executing their callback) still hold conceptual locks. If `reset()` clears `this.locked`, new operations can acquire the same key and run concurrently with the still-running old operation. Only clear `this.waiters` (to reject pending waiters with SyncResetError). Let running operations release their locks naturally via the `finally` block in `withLock`.

**4. `handleMaybeMergingResponse` must write the file BEFORE updating metadata.**
If metadata is updated first and the write fails (crash, OS error), the metadata points to a server version whose content was never written locally. On recovery, the stale local content is uploaded, potentially overwriting other clients' changes that were part of the merge. Order: write file → re-read + re-hash → update metadata → update cache.

**5. After a MergingUpdate, cache the SERVER's content (`responseBytes`), not the local content.**
The content cache is used to compute diffs for subsequent updates: `diff(cached, newFileContent)`. The server applies this diff against its content at `parentVersionId`. If the cache stores the local content (which may differ from the server's due to the 3-way merge in `FileOperations.write`), the diff won't match the server's state and the update will fail with "Invalid diff".

**6. After a MergingUpdate, re-read the file and re-hash.**
The 3-way merge in `operations.write()` may produce content different from `responseBytes` (because the user edited the file between the read and the write). The stored hash must match the actual on-disk content, not the server's merged content. Otherwise, the next sync cycle incorrectly detects "no changes" (phantom hash match) or always detects changes (phantom hash mismatch).

**7. Snapshot `parentVersionId` before computing diffs.**
`document.metadata` is a mutable shared reference. A concurrent operation (via a WebSocket handler running during an `await` in the same sync operation) can update `parentVersionId` between the cache lookup and the `putText` call. Always capture `const parentVersionIdForUpdate = document.metadata.parentVersionId` and use that value for both the cache lookup and the HTTP request.

**8. Guard `updateDocumentMetadata` against concurrently removed documents.**
After any `await` (file write, re-read, HTTP call), the document may have been removed from the database by a concurrent delete operation. Always check `database.containsDocument(document)` before calling `updateDocumentMetadata` if there was an `await` since the document reference was obtained. Return gracefully if removed — the file is on disk and `scheduleSyncForOfflineChanges` will re-detect it.

**9. When assigning a `documentId` to a pending doc, check for duplicates first.**
Both `resolveIdempotencyKeys` and `handleMaybeMergingResponse` (for deleted pending docs) assign documentIds. Before setting metadata, call `getDocumentByDocumentId(id)`. If another document already has that ID, remove the stale pending doc instead of creating a duplicate. `ensureConsistency` checks for duplicate documentIds across ALL documents (not just `resolvedDocuments`).

**10. `resolveIdempotencyKeys` sets `parentVersionId: 0` — treat this as a create, not an update.**
When `resolveIdempotencyKeys` assigns a documentId to a pending doc, it uses `parentVersionId: 0` as a placeholder. The sync path must check for `parentVersionId === 0` and take the CREATE path (sending a create with the idempotency key), not the UPDATE path (which would fail because version 0 doesn't exist on the server).

**11. Idempotent create returns can have stale content — always fetch server content.**
When the server returns a `FastForwardUpdate` for a create with an idempotency key, it may return the ORIGINAL version (from the first create), not a new version with the current content. Always fetch the actual server content for idempotent create returns (the `isCreate` path in `handleMaybeMergingResponse`) and use it for the cache and hash, so subsequent diffs are correct. Do not use a content-length comparison as a shortcut — two different byte sequences can have the same length.

**12. `SyncClient.pause()` must swallow `SyncResetError`.**
`pause()` calls `fetchController.startReset()` which rejects in-flight fetches. Those rejections propagate through `waitUntilFinished()`. Since `pause()` CAUSED the reset, the resulting `SyncResetError` is expected and must be caught (not re-thrown). Only re-throw non-SyncResetError exceptions. Also call `fetchController.finishReset()` in the catch block to prevent the FetchController from getting stuck in resetting state.

**13. `runningScheduleSyncForOfflineChanges` must be cleared on WebSocket disconnect.**
After the initial `scheduleSyncForOfflineChanges()` completes, the field retains the resolved promise. On WebSocket disconnect/reconnect (without a full client reset), the field must be cleared so the next call triggers a fresh filesystem scan. Add a handler on `onWebSocketStatusChanged` that sets the field to `undefined` when `isConnected` is false.

**14. The server must not `expect()` / panic on UTF-8 conversion — return a client error.**
In `update_text`, the parent version's content may be binary (if another client uploaded binary via `putBinary`). Using `.expect()` on `str::from_utf8()` panics the server. Use `.context(...).map_err(client_error)?` to return a 4xx error, allowing the client to fall back to `putBinary`.

**15. The create-merge parent content must be empty (`&Vec::new()`), not `latest_version.content`.**
In `create_document.rs`, when a create merges with an existing document, the 3-way merge parent must be an empty vector (`&Vec::new()`), not the latest version's content. Using `latest_version.content` as the parent makes `reconcile(A, A, B) = B`, which silently discards the existing content (last-write-wins). An empty parent causes `reconcile("", existing, new)` to correctly treat both sides as independent additions and merge them together.

**16. `retryForever` must not retry 4xx HTTP errors.**
4xx errors indicate the request itself is wrong (e.g., invalid diff, missing parent version). Retrying won't help. The `HttpClientError` class (in `errors/http-client-error.ts`) carries the status code. `retryForever` checks for it and re-throws immediately. Only 5xx errors (transient server failures) are retried.

**17. The broadcast channel's `RecvError::Lagged` must be handled explicitly.**
The `while let Ok(update) = broadcast_receiver.recv().await` pattern silently exits the loop on `Lagged`, disconnecting the client without logging. Handle `Lagged` explicitly with a `warn!` log and `break`. The channel capacity is `max_clients_per_vault`.

**18. `merge_with_stored_version` must not short-circuit when an idempotency key is provided.**
When the new content is identical to the latest version and an `idempotency_key` is present, the function must still insert a new version row so the key is persisted in the database. Without this, the key is lost: `resolveIdempotencyKeys` returns no match after a crash, and the client retries the create without idempotency protection — potentially doubling content via the empty-parent merge. The short-circuit (`content == latest_version.content && ... && idempotency_key.is_none()`) only applies to keyless updates.

**19. The idempotency key check in `create_document` must skip deleted documents.**
When `get_document_by_idempotency_key` returns a document with `is_deleted: true`, the server must NOT return it as an idempotent match. Returning a deleted version causes the client to call `applyRemoteDeleteLocally`, silently deleting the user's local file. Instead, fall through to the normal create path so the file is preserved as a new document.

**20. `syncLocallyCreatedFile` must treat `parentVersionId === 0` as needing a create retry.**
When `resolveIdempotencyKeys` assigns metadata with `parentVersionId: 0`, the document looks "resolved" to `syncLocallyCreatedFile` (it has `metadata !== undefined`). Without a special check for `parentVersionId === 0`, the method returns early ("already exists with metadata"), leaving the document permanently stuck — it never syncs. The fix: when `parentVersionId === 0`, treat it like a pending create retry and enqueue `unrestrictedSyncLocallyCreatedOrUpdatedFile`.

**21. The client must normalize content to UTF-8 at the read boundary.**
`FileOperations.read()` calls `normalizeToUtf8()` to transcode UTF-16 (detected by BOM) to UTF-8 before any downstream code sees the bytes. This means `isBinary` / `is_binary` on both client and server only need to check UTF-8 validity — no UTF-16 handling required. A disagreement between client and server on text vs binary causes permanent sync failures (client sends `putText` for content the server considers binary, 4xx error, `retryForever` won't retry). The UTF-8-only contract keeps classification trivial and impossible to get out of sync.

### E2E Test Debugging Guide

**How to run E2E tests:**
```bash
cd sync-server && rm -rf databases && ./target/release/sync_server config-e2e.yml &
sleep 3
cd /volumes/syncthing/Projects/vault-link && scripts/e2e.sh 8
```
Always clean the `databases` directory before running. The server must be running separately.

**Common E2E failure patterns:**

1. **`SyncResetError` unhandled rejection**: Check that `enqueueSyncOperation` catches all errors and that `pause()` swallows SyncResetError. The test client's `unhandledRejection` handler checks `error.name === "SyncResetError"` — if the error message changes, update the filter in `test-client/src/cli.ts`.

2. **"Files from agent-X missing in agent-Y"**: This is a consistency assertion. Check the agent's LOCAL file list (now correctly logged per-agent after a logging bug fix). Common causes:
   - **Broadcasts lost during shutdown**: Operations completed on one agent but the WebSocket broadcast didn't reach the other before destroy. The 5-second sleep between finish and destroy helps.
   - **Path deconfliction**: Both agents have the same DOCUMENT but at different LOCAL paths (e.g., `binary-10.bin` vs `binary-10 (1).bin`). This is a known limitation with concurrent creates at the same path.
   - **Failed sync operations not retried**: If `executeSync` throws, the failed file won't be retried until the next WebSocket reconnect (which clears `runningScheduleSyncForOfflineChanges` and triggers a fresh filesystem scan).

3. **"Document not found in database"**: A concurrent operation removed the document between the last `await` and the `updateDocumentMetadata` call. Add a `containsDocument` guard.

4. **"Duplicate documentId found in database"**: Two documents have the same `documentId`. Usually caused by `resolveIdempotencyKeys` or `handleMaybeMergingResponse` assigning a documentId without checking if another doc already has it.

5. **"Invalid diff: attempting to access N characters..."**: The content cache has wrong content for a `parentVersionId`. Common causes: (a) cached local content instead of server content after MergingUpdate; (b) idempotent create returned a stale version but the client cached its current content under that version ID; (c) `parentVersionId` changed between cache lookup and `putText` call due to mutable shared reference.

6. **"Parent version with id 0 not found"**: A document's `parentVersionId` is 0 (set by `resolveIdempotencyKeys`). The sync path should treat `parentVersionId === 0` as a create, not an update.

**Test client internals (`test-client/src/agent/mock-agent.ts`):**
- `files`: InMemoryFileSystem map — the ACTUAL filesystem state
- `data`: Map of expected file contents — what the agent CREATED/UPDATED
- `assertFileSystemsAreConsistent`: Compares `files` maps between two agents
- `assertAllContentIsPresentOnce`: Checks no duplicate content across files
- The `finish()` and `destroy()` methods use `withTimeout(TIMEOUT_MS)` — operations that exceed 30s are killed

**Logging bug (fixed):** In `assertFileSystemsAreConsistent`, the error handler's "Local files" log previously printed `otherAgent.files.keys()` for BOTH agents. Now correctly prints `this.files.keys()` for the current agent.
