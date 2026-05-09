# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

VaultLink is a self-hosted Obsidian file-sync system. Two halves of one repo:

- `sync-server/` — Rust (axum + sqlx/SQLite). Source of truth for vault state, broadcasts changes via WebSocket.
- `frontend/` — npm workspaces. The sync engine (`sync-client`) is consumed by an Obsidian plugin, a standalone CLI, a fuzz E2E harness, and a scripted determinism harness.

The HTTP/WS API types are generated from Rust (`ts-rs`) and mirrored into the TS workspaces. **Never hand-edit files in `frontend/sync-client/src/services/types/`** — run `scripts/update-api-types.sh` after changing anything Serde-derived in the server.

### Frontend workspaces

- `sync-client` — the sync engine; published to consumers via `dist/`. All other TS workspaces depend on it via `file:../sync-client`.
- `obsidian-plugin` — Obsidian plugin built from `sync-client`.
- `local-client-cli` — same engine wrapped as a standalone CLI.
- `test-client` — fuzz E2E harness (random ops across N processes).
- `deterministic-tests` — scripted multi-client tests with an in-memory FS, run against a real server.

## Common commands

Pre-push hygiene (formats, lints, runs tests, requires clean git state):

```sh
scripts/check.sh --fix
```

Run the fuzz E2E (N parallel processes):

```sh
scripts/e2e.sh 12
# Logs land in logs/log_<i>.log. Clean with scripts/clean-up.sh
```

Run deterministic tests (require a release-built server in `sync-server/target/release/sync_server` — they spawn it themselves):

```sh
cd sync-server && cargo build --release && cd ..
cd frontend
npm run build -w sync-client -w deterministic-tests
node deterministic-tests/dist/cli.js                       # all
node deterministic-tests/dist/cli.js --filter=rename       # subset
node deterministic-tests/dist/cli.js --filter=… -j 4       # cap parallelism
```

Run a single sync-client unit test by file:

```sh
cd frontend/sync-client && npx tsx --test 'src/**/sync-event-queue.test.ts'
```

Server: dev runs from `sync-server/` against `config-e2e.yml`:

```sh
cd sync-server
cargo run config-e2e.yml          # dev
cargo build --release             # used by both e2e harnesses
cargo test                        # unit + ts-rs binding export tests
```

Frontend dev (sync-client + obsidian-plugin watch in parallel):

```sh
cd frontend && npm install && npm run dev
```

Regenerate TS bindings from Rust types (touches `frontend/sync-client/src/services/types/`):

```sh
scripts/update-api-types.sh
```

## SQLite / sqlx

The server uses `sqlx::query!` macros that need a prepared `.sqlx` cache to compile offline. Touching any SQL means regenerating it:

```sh
cd sync-server
sqlx database create --database-url sqlite://db.sqlite3
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
cargo sqlx prepare --workspace
```

New migrations: `sqlx migrate add --source src/app_state/database/migrations <name>`.

## Sync engine architecture

Read `frontend/sync-client/src/sync-operations/` to follow the sync engine; the rest of `sync-client` is plumbing (filesystem ops, persistence, services, telemetry).

The engine is **two independent loops with separate invariants**:

- **Wire loop** (`syncer.ts`) — drains the single-consumer FIFO queue. HTTP and WS handlers update record fields (`remoteRelativePath`, `parentVersionId`, `remoteHash`) and write content to the file at `record.localPath`. They never move files for path placement.
- **Path reconciler** (`reconciler.ts`) — runs after every drained event. Best-effort pass that moves files to make `localPath === remoteRelativePath`. The move graph is topologically sorted; cycles are resolved by reading every file in the cycle into memory and writing each back to its new slot (no tmp files). Records with pending local events are skipped on each pass — the reconciler operates only on settled records. Failures (slot occupied by an untracked file, etc.) are silent skips; the next pass retries.

**`SyncEventQueue`** (`sync-event-queue.ts`) holds:

- `byDocId: Map<DocumentId, DocumentRecord>` — primary record store.
- `byLocalPath: Map<RelativePath, DocumentRecord>` — derived index for path lookups, maintained at every mutation point.
- `events: SyncEvent[]` — pending wire ops in FIFO drain order.

```ts
DocumentRecord = {
    documentId,
    parentVersionId,
    remoteHash?,
    remoteRelativePath,
    localPath: RelativePath | undefined
}
```

`localPath === undefined` means the doc has no local file yet — typically a remote create whose target slot was occupied at receive time; the reconciler will fetch and place when the slot frees (the bytes wait in `pendingPlacementContent`).

Local FS events from the watcher update `localPath` synchronously at enqueue time via `setLocalPath` / `upsertRecord`. The wire loop never updates it for path placement; only the reconciler does. A user rename onto a tracked slot enqueues a `LocalDelete` for the displaced doc (the OS rename clobbered its content) and clears that doc's `localPath`.

**Pending creates** use a `Promise<DocumentId>` chain to serialize dependent ops (`LocalUpdate`, `LocalDelete`) behind the still-in-flight `LocalCreate`. `resolveCreate` resolves the promise once the server returns a docId, and `replacePendingDocumentId` swaps the resolved id across already-queued events. `findLatestCreateForPath` is the lookup the watcher uses to attach dependents; `updatePendingCreatePath` rewrites a pending create's `event.path` in place when the user renames the file before its create has acked.

**Watermark.** `lastSeenUpdateId` uses a `MinCovered` (a contiguous-prefix tracker over a stream of integers): we only advance the published min when the next consecutive id has been processed, so out-of-order RemoteChange ids don't fool the WebSocket handshake into requesting a too-recent catch-up.

**Server catch-up.** The server's WS handshake replays events newer than the client's `last_seen_vault_update_id` from the `latest_document_versions` view (one row per doc, the latest). On those replayed rows `is_new_file` means _new to this client_ (`creation_vault_update_id > last_seen_vault_update_id`), not "this row is the doc's first version" — necessary because the catch-up only carries the latest version; if a doc was created and updated past the watermark, the client never sees its create otherwise.

## Edge-case patterns the sync engine has to survive

The two-loop split defuses most of the old race catalogue (slot-collision stashes, conflict-uuid divergence, `MoveOnConflict.NEW`/`EXISTING` policy choices) by separating wire transport from path placement. What's left:

**Pending-create docId is a `Promise`, not a string, until the create acks.** Any `LocalUpdate` / `LocalDelete` queued behind a still-in-flight `LocalCreate` carries the create's `resolvers.promise` as its `documentId`. `replacePendingDocumentId` swaps the resolved id across queued events when the create resolves; `===` comparisons against the resolved string elsewhere will silently fail until that swap runs. Anything that walks `events[]` looking for a docId match must either run after the swap or be tolerant of `Promise`-typed ids.

**`processCreate` reads `event.path` live, not `event.originalPath`.** The watcher rewrites `event.path` in place via `updatePendingCreatePath` when the user renames a pending-create file. `originalPath` was removed from `LocalCreate` events specifically because reading it would send the stale pre-rename path to the server.

**`record.localPath` mutates in place across awaits.** When the watcher renames a doc while a drain handler is awaiting an HTTP roundtrip, the queue mutates the in-flight event's record so subsequent reads see the new path. Snapshotting `record.localPath` into a local at function entry and using it after an `await` reads/writes a now-vacated slot. Read `record.localPath` live; only snapshot for the deliberate "did it change while I was awaiting" comparison.

**Reconciler-defer is the wire-loop's contract with the reconciler.** The reconciler skips records where `hasPendingLocalEventsForDocumentId` returns true. Wire-loop handlers can therefore freely write `remoteRelativePath` to whatever the server returned — even if it disagrees with `localPath` — knowing the reconciler won't move the file out from under a queued user rename.

**Watermark advancement is load-bearing both ways.** Branches that _skip_ a remote event without advancing `lastSeenUpdateId` create permanent gaps that re-deliver forever. Branches that _advance_ without applying the content lose data: the server has no further event to re-deliver, the catch-up only carries the latest version, and any state in between is gone. Don't advance unless the event was actually applied (or deliberately discarded after weighing both halves).

**`isNewFile` semantics differ between catch-up and real-time.** On WS handshake replay it means _new to this client_ (`creation_vault_update_id > last_seen_vault_update_id`); on real-time broadcasts it means _this version is the create_ (`creation_vault_update_id == vault_update_id`). A handler that decides based on one interpretation will be wrong on the other channel; reasoning about fetch-and-treat-as-new vs. ignore needs to know which channel delivered the event.

**Pause / disable-sync mid-flight** is the one race the new model doesn't structurally fix. An HTTP that committed server-side but whose response was discarded leaves the server holding a doc the client has no record of. Resume → offline scan → server-side dedupe handles it (the server merges the duplicate create into the existing doc), but if the merge produces a deconflict, the client picks up an extra file. Out of scope for the two-loop split.

**Cycle reconciliation uses in-memory content swap.** When the move graph contains a cycle, the reconciler reads every file in the cycle into memory and writes each back to its new slot, with no tmp files. A write-ahead marker at `.vaultlink/swap-<uuid>.json` lists each leg; on startup the reconciler reads the marker, hashes each `from` to determine which legs ran, and replays the rest. The `.vaultlink/**` glob is hard-coded as an internal ignore pattern so swap markers don't get sync'd.

## Two complementary E2E harnesses

- **`test-client` (fuzz):** random ops across N parallel processes for many minutes. Used by `scripts/e2e.sh`. Catches bugs nobody thought to write a test for, but reproductions are noisy.
- **`deterministic-tests`:** scripted scenarios with an in-memory FS pinned to a real server. Used to _capture_ a fuzz-discovered bug as a minimal repro before fixing it. See `frontend/deterministic-tests/README.md` for the step grammar (`pause-server`, `pause-websocket`, `barrier`, `assert-consistent`, etc.).

When a fuzz failure surfaces, the workflow is: root-cause from logs → write a deterministic test that fails on the bug → fix → confirm both the deterministic test and `e2e.sh` pass.

## Style

- TS: 4-space indent, no tabs, LF, prettier (`trailingComma: "none"`). YAML/MD use 2-space indent.
- Rust: `rustfmt.toml` enforces 4-space spaces, LF.
- Lint: ESLint for TS, Clippy for Rust, `cargo machete` for unused deps. All wired into `scripts/check.sh`.
