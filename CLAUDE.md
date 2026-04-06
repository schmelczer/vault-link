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

**Client Architecture (Serial Event Queue Model):**

- `SyncClient`: Main entry point, orchestrates all sync operations
- `SyncService`: HTTP API client for CRUD operations on documents
- `WebSocketManager`: Manages WebSocket connection and real-time updates
- `Syncer`: Coordinates file synchronisation via a serial drain loop over a `SyncEventQueue`
- `SyncEventQueue`: Intent queue that coalesces events and tracks path→documentId mappings
- `CursorTracker`: Manages local and remote cursor positions
- `Database`: Client-side document metadata cache (persisted via `PersistenceProvider`)
- `FileOperations`: Abstraction layer for filesystem operations (3-way merge on write)

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
- **Deterministic**: Step-by-step sync scenario tests in `frontend/deterministic-tests/`

### Deterministic Tests (`frontend/deterministic-tests/`)

Controlled, step-by-step sync scenario tests that exercise specific edge cases. Each test defines a sequence of operations (create, update, rename, delete, enable/disable sync, pause/resume server) and asserts convergence across multiple agents.

**Running:**

```bash
cd frontend/deterministic-tests
npx webpack --config webpack.config.js   # Build (required after changes)
node dist/cli.js                          # Run all tests
node dist/cli.js --filter=write-write     # Run tests matching a name/key
```

Requires the server binary at `sync-server/target/release/sync_server` and `sync-server/config-e2e.yml`. The harness starts/stops servers automatically.

**Architecture:**

- `DeterministicAgent` extends `InMemoryFileSystem` — wraps a real `SyncClient` with an in-memory filesystem
- `TestRunner` executes `TestStep[]` sequentially, manages agent lifecycle
- `ServerControl` manages server processes (start/stop/SIGSTOP/SIGCONT)
- Tests that use `pause-server`/`resume-server` get dedicated server instances; regular tests share one
- Each test gets a unique vault name (UUID) for isolation

**Writing Tests — Step Types:**

```typescript
{ type: "create", client: 0, path: "A.md", content: "hello" }
{ type: "update", client: 0, path: "A.md", content: "updated" }
{ type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" }
{ type: "delete", client: 0, path: "A.md" }
{ type: "enable-sync", client: 0 }      // Connects WS, triggers reconciliation
{ type: "disable-sync", client: 0 }     // Disconnects WS
{ type: "sync", client: 0 }             // Wait for specific client to settle
{ type: "sync" }                         // Wait for ALL clients to settle
{ type: "barrier" }                      // Wait for convergence + check consistency
{ type: "pause-server" }                 // SIGSTOP the server process
{ type: "resume-server" }               // SIGCONT + wait for readiness
{ type: "assert-consistent", verify?: (state: AssertableState) => void }
```

**Critical Rules When Writing Tests:**

1. **Agents start with sync DISABLED.** Do not `disable-sync` on an agent that hasn't been `enable-sync`'d — it's already off.

2. **Do not put `{ type: "sync" }` before `{ type: "barrier" }`.** The barrier already calls `waitAllAgentsSettled()` (2 rounds of `waitForSync` on all agents). Adding a `sync` before it is pure redundancy. Use targeted `{ type: "sync", client: N }` only when you need a specific client to finish before another client acts.

3. **`enable-sync` blocks until WebSocket connects.** If the server is paused (SIGSTOP), `enable-sync` will hang for 10 seconds then fail. Never `enable-sync` while the server is paused. Tests that need to stall in-flight requests should enable sync FIRST, then pause the server.

4. **File operations while sync is disabled are queued.** When `createFile` is called on the agent, `enqueueSync(syncLocallyCreatedFile)` fires immediately but the fetch is disabled. The `scheduleSyncForOfflineChanges` reconciliation scans the filesystem and re-enqueues all pending changes on the next `enable-sync`.

5. **`barrier` retries for up to 60 seconds.** It calls `waitAllAgentsSettled`, checks consistency, and if clients disagree, sleeps 500ms and retries. Tests that need more settling time should add targeted `sync` steps before the barrier (e.g., `{ type: "sync", client: 0 }` to ensure client 0's operations complete first).

6. **No comments in test files.** The test name/description and step types are self-documenting. Keep test files comment-free.

7. **Keep tests minimal.** Each test should reproduce exactly one edge case with the fewest steps possible. Don't add `assert-consistent` after `barrier` unless it has a `verify` callback (barrier already checks consistency). Always use inline arrow functions for `verify` callbacks rather than separate named functions.

8. **Treat sync as a black box in test names/descriptions.** Don't reference internal implementation details (VFS, coalescing, idempotency keys, reconciliation, parentVersionId, etc.). Describe the observable scenario and expected outcome from the user's perspective.

**Test Patterns for Common Edge Cases:**

*Two clients create at same path (offline):*
```typescript
steps: [
    { type: "create", client: 0, path: "A.md", content: "hello" },
    { type: "create", client: 1, path: "A.md", content: "world" },
    { type: "enable-sync", client: 0 },
    { type: "enable-sync", client: 1 },
    { type: "barrier" },
    { type: "assert-consistent", verify: verifyMergedContent }
]
```

*Client edits while other client is offline:*
```typescript
steps: [
    { type: "create", client: 0, path: "A.md", content: "original" },
    { type: "enable-sync", client: 0 },
    { type: "enable-sync", client: 1 },
    { type: "barrier" },
    // Client 1 goes offline, client 0 edits
    { type: "disable-sync", client: 1 },
    { type: "update", client: 0, path: "A.md", content: "edited" },
    { type: "sync", client: 0 },
    // Client 1 reconnects
    { type: "enable-sync", client: 1 },
    { type: "barrier" },
    { type: "assert-consistent" }
]
```

*Testing behavior during server pause (stalled HTTP requests):*
```typescript
steps: [
    // Setup FIRST — both clients must be online before pausing
    { type: "enable-sync", client: 0 },
    { type: "enable-sync", client: 1 },
    { type: "barrier" },
    // NOW pause — in-flight requests from subsequent operations will stall
    { type: "pause-server" },
    { type: "create", client: 0, path: "A.md", content: "hello" },
    { type: "resume-server" },
    { type: "barrier" },
    { type: "assert-consistent" }
]
```

**Verify Functions and `AssertableState`:**

The `verify` callback on `assert-consistent` receives an `AssertableState` object (defined in `utils/assertable-state.ts`) with chainable assertion methods:

```typescript
state.assertFileCount(2)                          // exact file count
state.assertFileExists("A.md")                    // file must exist
state.assertFileNotExists("old.md")               // file must not exist
state.assertContent("A.md", "hello")              // exact content match
state.assertContains("A.md", "hello", "world")    // all substrings present
state.assertContainsAny("A.md", "hello", "world") // at least one substring
state.assertAnyFileContains("content-a")           // substring in any file
state.assertSubstringCount("A.md", "hello", 1)    // occurrence count
state.assertContentInAtMostOneFile("original")     // no duplicate content
state.ifFileExists("A.md", (s) => ...)            // conditional assertion
state.getContent("A.md")                          // raw content access
```

All methods return `this` for chaining. The object also exposes `files` and `clientFiles` for custom logic.

For conflict-resolution tests where the outcome is genuinely ambiguous (delete vs update, rename ordering), use `ifFileExists`. For merges where both sides MUST be preserved, use `assertContains`. When the empty-parent merge (invariant #15) is involved, word boundaries may be garbled — check for fragments, not exact substrings.

```typescript
function verify(state: AssertableState): void {
    state.ifFileExists("A.md", (s) => s.assertContent("A.md", "expected content"));
}

function verify(state: AssertableState): void {
    state.assertContains("A.md", "edit from 0", "edit from 1");
}
```

**Adding a New Test:**

1. Create `frontend/deterministic-tests/src/tests/your-test-name.test.ts`
2. Export a `TestDefinition` with `clients` and `steps` (the test name is derived from the registry key)
3. Import and register in `test-registry.ts`
4. Build with `npx webpack --config webpack.config.js`
5. Run with `node dist/cli.js --filter=your-test-name`

**Known Limitations:**

- Cannot test VFS.move failures — the in-memory filesystem never fails
- Cannot `enable-sync` while the server is paused — the WebSocket connection will time out
- The empty-parent 3-way merge (used for smart creates) can produce garbled word boundaries — check for fragments, not exact substrings
- The test harness can hang during shared server cleanup when transitioning to server-pause tests

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

### Architecture: Serial Event Queue (Command Sourcing)

The sync client uses a **serial event queue** pattern inspired by Dropbox's Nucleus rewrite. All sync decisions run through a single `drain()` loop — one event at a time. There are no per-document locks, no concurrent sync queues, and no PQueue. JS is single-threaded, so in-memory state changes between `await` points are impossible.

**Core components:**

- `SyncEventQueue` — intent queue that stores `SyncEvent[]` and a `documentIdsByPath` map (path → `{ documentId, hash, vaultUpdateId }`). Events are coalesced at dequeue time (not enqueue time)
- `Syncer.drain()` — serial loop that calls `next()` on the queue and processes one event at a time
- `Syncer.scheduleDrain()` — chains new drains after existing ones via `.then()` to ensure items enqueued during a drain are always processed by a subsequent drain

**Event types:**

| Event | Enqueued by | Processing |
|-------|-------------|------------|
| `create` | `syncLocallyCreatedFile` | Read file, POST to server, resolve promise-based documentId |
| `delete` | `syncLocallyDeletedFile`, auto (move-overwrite) | DELETE on server, mark `isDeleted` in database |
| `move` | `syncLocallyUpdatedFile` (with `oldPath`) | PUT with new path, server returns updated document |
| `local-content-update` | `syncLocallyUpdatedFile` (no `oldPath`) | Read file, compute diff, PUT to server |
| `remote-update` | `syncRemotelyUpdatedFile` (WebSocket) | Fetch from server, write locally, or merge |

**Event coalescing in `next()`:**

1. If there is an eventual `delete` for a document, all preceding events for that document are discarded — only the delete is returned
2. Multiple `local-content-update` / `remote-update` events for the same document coalesce to the last one (the file is re-read at processing time anyway)
3. `move` events act as barriers — updates cannot coalesce across a move since the path changed
4. `create` events are always returned immediately (FIFO) since they carry a `resolve` callback

**Promise-based documentIds for pending creates:**

When a `create` event is enqueued, `Promise.withResolvers<DocumentId>()` creates a promise. The `resolve` function is stored on the event. Subsequent events for the same path (move, delete, update) carry this promise as their `documentId`. When `processCreate` gets the server response, it calls `event.resolve(response.documentId)`, and all dependent events can then `await` the resolved ID.

### Move-to-Occupied-Path Handling

When the user renames a file to a path where another file already exists (overwrite semantics), the queue automatically enqueues a `delete` for the occupying document before the `move`. The `syncLocallyUpdatedFile` method also marks the displaced document as deleted in the database and clears it from the path to allow `database.move()` to succeed.

### Remote Delete vs Local Changes

When a remote delete arrives for a document that has been locally modified (hash differs from the last synced hash), the local changes survive. The client:
1. Removes the old document record from the database
2. Re-creates the file as a new document via `syncLocallyCreatedFile`

This preserves the user's edits. If the file has NOT been modified locally, the delete is applied normally.

The same logic applies in `handleMaybeMergingResponse`: if the server returns `isDeleted: true` for an update but the file still exists locally, the file is re-uploaded as a new document rather than being deleted.

### The Offline Sync Algorithm (`scheduleSyncForOfflineChanges`)

Runs on reconnect to detect what changed while offline:

1. Register all known documents from the database into the queue's path→documentId map
2. List all local files
3. For each file at a known path: **hash-check** against the database record. If the hash doesn't match AND matches a document missing from disk elsewhere, treat it as a rename (the file was moved to this path while offline, displacing the original document)
4. For each file without metadata at its path: try to match against "missing" DB records by content hash (detects moves). If no match, schedule as create
5. For DB records whose files don't exist locally: schedule as delete
6. Ordering: deletes first → updates/moves second → creates last. Creates run after deletes so the server can merge creates with existing documents at the same path

### Remote Update Processing

When the server broadcasts updates via WebSocket:

1. `scheduleSyncForOfflineChanges()` runs first (ensures local changes are queued)
2. Remote updates are enqueued with full `DocumentVersionWithoutContent` metadata (avoids an extra network call)
3. For each remote document:
   - **Known document, already up-to-date** (`parentVersionId >= remoteVersion.vaultUpdateId`): skip
   - **Known document, remote delete**: check for local changes; if present, re-create; if not, delete
   - **Known document, remote update with local changes**: send local changes (server merges)
   - **Known document, remote update without local changes**: fetch and apply
   - **Unknown document, deleted**: skip
   - **Unknown document, live**: download and create locally

### Drain Scheduling

`scheduleDrain()` chains drain promises: `this.draining = (this.draining ?? Promise.resolve()).then(() => this.drain())`. This ensures that events enqueued during an `await` inside a running drain are always processed by the next drain in the chain. The previous approach of storing a single `this.draining` promise and checking `undefined` had a race condition where events enqueued between the drain finishing and the `finally` block clearing `this.draining` were never processed.

### Server-Side Smart Create

When a client sends a create request for a path where a document already exists:

1. Server calls `merge_with_stored_version` instead of creating a new document
2. Content is 3-way merged using `reconcile-text` (for text files) or last-write-wins (for binary)
3. The merge parent is an empty string, not the existing content — this treats both sides as independent additions
4. The response uses the EXISTING document's `documentId` — the client adopts it

### Sync Reset and Recovery

A `SyncResetError` is thrown when the WebSocket disconnects or sync is toggled off. This:
- Clears the event queue (events + path map)
- On reconnect, `scheduleSyncForOfflineChanges()` runs a fresh filesystem scan

`runningScheduleSyncForOfflineChanges` is cleared on WebSocket disconnect so the next connection triggers a fresh scan.

**Important**: `SyncResetError` during `syncRemotelyUpdatedFile` must be caught and logged as INFO, not ERROR. The test client exits on ERROR-level logs, so logging SyncResetError as ERROR during expected resets causes false test failures.

### Critical Implementation Invariants

These invariants were discovered through testing. Violating them causes data loss, sync stalls, or test failures.

**Client-side invariants:**

**1. `handleMaybeMergingResponse` must write the file BEFORE updating metadata.**
Order: write file → re-read + re-hash → update metadata → update cache. If metadata is updated first and the write fails, the metadata points to a server version whose content was never written locally.

**2. After a MergingUpdate, cache the SERVER's content (`responseBytes`), not the local content.**
The content cache is used to compute diffs: `diff(cached, newFileContent)`. The server applies this diff against its content at `parentVersionId`. If the cache stores local content (which may differ due to the 3-way merge in `FileOperations.write`), subsequent diffs produce "Invalid diff" errors.

**3. After a MergingUpdate, re-read the file and re-hash.**
The 3-way merge in `operations.write()` may produce content different from `responseBytes`. The stored hash must match actual on-disk content, not the server's merged content.

**4. The drain must be chained, not gated.**
`scheduleDrain()` must chain via `.then()`: `this.draining = (this.draining ?? Promise.resolve()).then(() => this.drain())`. A gate pattern (`if (this.draining === undefined)`) has a race condition: events enqueued after the drain finishes its while loop but before the `finally` block clears `this.draining` are never processed.

**5. `syncLocallyUpdatedFile` must guard against unregistered paths.**
If sync is disabled when a rename/update event arrives, the queue's path map may not have the path registered. Check `getDocumentId(path) !== undefined` before calling `enqueue` for `move` or `local-content-update` events.

**6. Move-to-occupied-path must auto-delete the target.**
When a rename overwrites an existing file, `syncLocallyUpdatedFile` must mark the target document as deleted in the database, and the queue must enqueue a `delete` for the occupying document before the `move` event.

**7. Remote deletes must check for local changes before applying.**
In `processRemoteUpdateForExistingDocument`, when `remoteVersion.isDeleted`, read the local file and compare its hash to the stored hash. If the hash differs, the user made local edits — re-upload as a new document instead of deleting. If `handleMaybeMergingResponse` receives `isDeleted: true` but the file still exists locally, also re-upload rather than delete.

**8. `processDelete` must mark `isDeleted` on the database record.**
Call `database.delete(relativePath)` after `updateDocumentMetadata` so the record has `isDeleted: true`. This is needed so that subsequent `database.move()` calls to the same path don't throw "Document already exists".

**9. Offline scan must hash-check files at known paths.**
When a file exists at a path with a database record but `locallyPossiblyDeletedFiles` is non-empty, hash the file and check if it matches a missing document. If so, the file was renamed to this path — enqueue as a move from the original path, and add the displaced document to the "possibly deleted" list.

**Server-side invariants:**

**10. The server must not `expect()` / panic on UTF-8 conversion — return a client error.**
In `update_text`, use `.context(...).map_err(client_error)?` instead of `.expect()` on `str::from_utf8()`.

**11. The create-merge parent content must be empty (`&Vec::new()`), not `latest_version.content`.**
An empty parent causes `reconcile("", existing, new)` to treat both sides as independent additions and merge them.

**12. `retryForever` must not retry 4xx HTTP errors.**
4xx errors indicate the request itself is wrong. Only 5xx errors (transient failures) are retried.

**13. The broadcast channel's `RecvError::Lagged` must be handled explicitly.**
Handle `Lagged` with a `warn!` log and `break`, not silently exit.

**14. `merge_with_stored_version` must not short-circuit when an idempotency key is provided.**
The key must be persisted even if content is identical — the short-circuit only applies to keyless updates.

**15. The idempotency key check in `create_document` must skip deleted documents.**
Returning a deleted version causes the client to delete the user's local file.

### File Operations Abstraction

`FileOperations` has an `ensureClearPath` method that renames existing files to `(1).md`, `(2).md` etc. if a file already exists at the target path. This prevents data loss but can create apparent duplicates if the sync logic doesn't handle it.

The `write` method does a 3-way merge: `write(path, oldContent, newContent)`. It reads the current file, computes a diff from `oldContent` to `newContent`, and applies that diff to the current file content. This preserves local changes that happened between the read and write.

### E2E Test Configuration

The test client (`frontend/test-client/src/cli.ts`) runs 5 iterations of 9 test configurations per process. Tests assert: file system consistency between agents AND no duplicate content across files.

**Running E2E**: Requires a server running with `config-e2e.yml`. Always clean the server databases before running.

**Known issue**: The deterministic test harness can hang during shared server cleanup when transitioning from regular tests to server-pause tests. This is an infrastructure issue, not a sync bug.



Never ever run git commands

Never put a full stop at the end of a single sentence comment

always use British English spellings

Never ever do fallbacks

Style guide

Don't write `super::device_id_header::DeviceIdHeader` instead `use super::device_id_header::DeviceIdHeader;` and then just write `DeviceIdHeader`