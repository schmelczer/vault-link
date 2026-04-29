# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

VaultLink is a self-hosted Obsidian file-sync system. Two halves of one repo:

- `sync-server/` — Rust (axum + sqlx/SQLite). Source of truth for vault state, broadcasts changes via WebSocket.
- `frontend/` — npm workspaces. The sync engine (`sync-client`) is consumed by an Obsidian plugin, a standalone CLI, a fuzz E2E harness, a scripted determinism harness, and a history UI.

The HTTP/WS API types are generated from Rust (`ts-rs`) and mirrored into the TS workspaces. **Never hand-edit files in `frontend/sync-client/src/services/types/` or `frontend/history-ui/src/lib/types/`** — run `scripts/update-api-types.sh` after changing anything Serde-derived in the server.

### Frontend workspaces

- `sync-client` — the sync engine; published to consumers via `dist/`. All other TS workspaces depend on it via `file:../sync-client`.
- `obsidian-plugin` — Obsidian plugin built from `sync-client`.
- `local-client-cli` — same engine wrapped as a standalone CLI.
- `history-ui` — vault-history web UI.
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

Regenerate TS bindings from Rust types (touches `frontend/{sync-client,history-ui}/src/.../types/`):

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

**`SyncEventQueue`** (`sync-event-queue.ts`) holds two things:

- `documents: Map<RelativePath, DocumentRecord>` — the local "settled" view of tracked docs.
- `events: SyncEvent[]` — pending operations (creates, updates, deletes, remote changes) in FIFO drain order.

The map is keyed by `record.path`; the invariant `documents.get(record.path) === record` is maintained by every mutation point (constructor, `setDocument`, the rename branch in `enqueue`). `setDocument` mutates the same record object in place when relocating, so callers holding a reference to the record see path changes on the next read — this is load-bearing for `Syncer`'s drain handlers, which await across HTTP roundtrips and would otherwise see a captured-string-stale path. Always read `record.path` live; only snapshot it into a local for the explicit "did the path change during my await" comparison (`pathBeforeRoundtrip` in `handleMaybeMergingResponse` / `processRemoteUpdate`).

**`Syncer`** (`syncer.ts`) drains events one at a time. Local creates/updates/deletes round-trip to the server over HTTP; remote changes arrive over the WebSocket and are enqueued as `RemoteChange` events that the same drain processes. `handleMaybeMergingResponse` is the shared response handler for create-and-update flows.

**Conflict-uuid paths.** When a remote create or remote-rename can't claim its server-side path locally (the slot is occupied), the local file lands at `conflict-<uuid>-<original>` and `record.intendedPath` records the path the server has it at. All server-bound requests honor `intendedPath`/`event.originalPath`, so the conflict-uuid path never leaks to the server. There is no automatic unwinding — convergence at conflict points is left to manual user resolution.

**Watermark.** `lastSeenUpdateId` uses a `MinCovered` (a contiguous-prefix tracker over a stream of integers): we only advance the published min when the next consecutive id has been processed, so out-of-order RemoteChange ids don't fool the WebSocket handshake into requesting a too-recent catch-up.

**Server catch-up.** The server's WS handshake replays events newer than the client's `last_seen_vault_update_id` from the `latest_document_versions` view (one row per doc, the latest). On those replayed rows `is_new_file` means *new to this client* (`creation_vault_update_id > last_seen_vault_update_id`), not "this row is the doc's first version" — necessary because the catch-up only carries the latest version; if a doc was created and updated past the watermark, the client never sees its create otherwise.

## Two complementary E2E harnesses

- **`test-client` (fuzz):** random ops across N parallel processes for many minutes. Used by `scripts/e2e.sh`. Catches bugs nobody thought to write a test for, but reproductions are noisy.
- **`deterministic-tests`:** scripted scenarios with an in-memory FS pinned to a real server. Used to *capture* a fuzz-discovered bug as a minimal repro before fixing it. See `frontend/deterministic-tests/README.md` for the step grammar (`pause-server`, `pause-websocket`, `barrier`, `assert-consistent`, etc.).

When a fuzz failure surfaces, the workflow is: root-cause from logs → write a deterministic test that fails on the bug → fix → confirm both the deterministic test and `e2e.sh` pass.

## Style

- TS: 4-space indent, no tabs, LF, prettier (`trailingComma: "none"`). YAML/MD use 2-space indent.
- Rust: `rustfmt.toml` enforces 4-space spaces, LF.
- Lint: ESLint for TS, Clippy for Rust, `cargo machete` for unused deps. All wired into `scripts/check.sh`.
