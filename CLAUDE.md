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

### Key Technologies

- **Backend**: Rust with Axum framework, SQLite with SQLx, WebSockets for real-time sync
- **Frontend**: TypeScript, Webpack for bundling, Node.js native test runner
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

The frontend uses npm workspaces with four packages:

- `sync-client`: Core synchronization logic (builds dual bundles for web and Node.js)
- `obsidian-plugin`: Obsidian-specific integration
- `test-client`: Testing utilities for E2E tests
- `local-client-cli`: Standalone CLI for VaultLink sync client

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
6. Deletes and updates run first, THEN creates — to avoid the server merging creates with about-to-be-deleted docs

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

8. **`resolveIdempotencyKeys` must not use `retryForever`**: The HTTP call to `/documents/resolve-keys` is an optimization. If it fails (e.g., SyncReset aborts the fetch), return an empty map and let the pending creates retry normally with their keys. Using `retryForever` can cause deadlocks — the sync pipeline stalls waiting for the retry while the WebSocket is disconnected.

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
