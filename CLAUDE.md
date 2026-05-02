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

## Edge-case patterns the sync engine has to survive

These are non-obvious from reading any single file; they fall out of the
interaction between the queue, the watcher, the WebSocket, and the
server's commit ordering. Treat the engine as a black box and what
follows is the kinds of bugs you should expect to see:

**FIFO drain order ≠ user's perceived order.** The queue is single-consumer
and FIFO at processing time, but the producers are concurrent and async
indirected: user FS actions go through watcher → microtask → enqueue
(several microtasks deep), while WS messages go through the onmessage
handler. A WS-driven event can land in the queue *between* two user
actions even when the user "did them in order". When you read a log,
"Decided to ..." timestamps mark the user's intent; they do **not** map
to the order of `events.push`.

**`event.path` is a side channel through disk.** Drain serialises which
event runs, but it can't lock disk between events. Between an event's
enqueue and its drain, another in-band event can have rewritten the
file at that path (a remote-create that landed on the slot, a delete +
re-create cycle by the user). Reading at drain time gets *current* disk
content — which may be a different doc's bytes — and uploading them as
the queued event's content is a duplicate-create / wrong-content bug.

**Pending-create docId is a `Promise`, not a string, until the create
acks.** Any event queued behind a still-in-flight LocalCreate that
references the same doc carries the create's `resolvers.promise` as its
`documentId`. Two consequences: (a) `===` comparisons against the
resolved string in any rewrite loop silently fail; (b) the order of
"swap Promise→docId" vs "rewrite paths in events" matters — swap first
or the rewrite walks past the events you wanted to retarget. This is
load-bearing in any code that touches the queue right after a create
resolves.

**`record.path` is mutated in place across awaits.** When a user rename
runs while a drain handler is awaiting an HTTP roundtrip, the queue
mutates the in-flight event's record so subsequent reads see the new
path. Snapshotting `record.path` into a local at function entry and
using it after an `await` writes/reads from a now-vacated slot.
Snapshot only for the *deliberate* "did the path change while I was
awaiting" comparison; everywhere else, read `record.path` live.

**Conflict-uuid stashes are local-only divergence.** Whenever a slot
collision deflects a doc to `conflict-<uuid>-…`, only the agent that
deflected has that file. The cross-agent fuzz assertion ("every path
matches across clients") will fire on it. By design these are awaiting
manual user resolution — but if your fix silently creates one in a
race that *would* converge given more time, the e2e fuzz will show it.

**`MoveOnConflict.NEW` vs `EXISTING` is a policy choice, not a default.**
NEW preserves the occupant and stashes us at conflict-uuid; EXISTING
evicts the occupant and stashes *them*. Picking wrong creates either an
orphaned stash on us or an orphaned tracking entry on the occupant.
The right choice depends on whether the occupant is tracked, whether
they have a pending RemoteChange that will move them, and which side
the server has already committed to.

**Pause / disable-sync mid-flight is a destabiliser.** A request whose
HTTP committed server-side but whose response was discarded by an abort
leaves the server holding a doc the client has no record of. The next
re-enable's offline scan re-derives state from disk vs. the (now
incomplete) `documents` map and emits a fresh LocalCreate — a duplicate
of a doc already on the server, with a new docId. The catch-up then
delivers the orphan as a "new" doc and writes it to disk. Final state:
two files, two docIds, same content. Anything that aborts in-flight
HTTPs (start-reset, vault change, destroy) needs the queue's documents
map to be wiped or rebuilt from the server, not just the events array.

**`scheduleSyncForOfflineChanges` clears `events[]` but not `documents`.**
Every enable-sync wipes pending local events. The offline scan
re-derives them by comparing disk to the documents map (matching by
content hash to recognise renames). This is correct *if* the documents
map reflects the last server state we committed to. If it lags (an
in-flight create whose response we lost; a remote update we haven't
applied yet), the scan misclassifies — a real rename becomes a delete
+ create with a new docId; a still-tracked doc whose file we deleted
becomes a delete the server hasn't seen.

**Watermark advancement is load-bearing both ways.** Branches that *skip*
a remote event without advancing `lastSeenUpdateId` create permanent
gaps that re-deliver forever. Branches that *advance* the watermark
without applying the content lose data — the server has no further
event to re-deliver, the catch-up only carries the latest version, and
any state in between is gone. When in doubt: don't advance unless the
event was actually applied (or deliberately discarded after weighing
both halves).

**`isNewFile` semantics differ between catch-up and real-time.** On WS
handshake replay it means *new to this client* (`creation_vault_update_id
> last_seen_vault_update_id`); on real-time broadcasts it means *this
version is the create* (`creation_vault_update_id == vault_update_id`).
A handler that receives "untracked doc + isNewFile=false" and decides
based on one of the two interpretations will be wrong on the other
channel. Reasoning about whether to fetch-and-treat-as-new vs. ignore
needs to know which channel delivered the event.

**Race-shape catalogue.** Bugs in this codebase tend to fall into a
small set of shapes; recognising the shape from the log gets you most
of the way to the cause:

- *Same-path dedup race*: two clients create at the same path. Server
  deconflicts the second to `path (1)`. The losing client must
  relocate locally; mishandling routes the local file to a stash.
- *Concurrent rename of same doc*: both clients rename. Server
  applies in commit order; the loser's local-rename HTTP must rebase
  against the server's new path or be dropped.
- *Local rename + remote rename of same doc*: the local rename's HTTP
  needs to find the doc at the (now-different) server path; the
  matching disk file needs to follow without stranding.
- *Pending create + remote create at same path*: the agent's pending
  file is already at the slot the remote wants; the remote's pending
  bytes will reach the slot the agent is trying to upload from.
- *Create + delete + remote create at same path*: the user's local
  cycle queues two events; a remote create lands in between. The
  queued LocalCreate (or a re-emitted offline-scan one) reads disk
  content placed by the remote and uploads it as a third doc.
- *Pause-mid-flight*: in-flight HTTP committed server-side, response
  abandoned client-side. After re-enable the offline scan can't tell
  the doc was already created and creates a duplicate.

When triaging a fuzz failure, find the divergent file in `e2e-run.log`'s
final dump (it shows each agent's tracked docs), grep the `log_<i>.log`
for that path/docId, and match the lifecycle against this catalogue
before going deeper.

## Two complementary E2E harnesses

- **`test-client` (fuzz):** random ops across N parallel processes for many minutes. Used by `scripts/e2e.sh`. Catches bugs nobody thought to write a test for, but reproductions are noisy.
- **`deterministic-tests`:** scripted scenarios with an in-memory FS pinned to a real server. Used to *capture* a fuzz-discovered bug as a minimal repro before fixing it. See `frontend/deterministic-tests/README.md` for the step grammar (`pause-server`, `pause-websocket`, `barrier`, `assert-consistent`, etc.).

When a fuzz failure surfaces, the workflow is: root-cause from logs → write a deterministic test that fails on the bug → fix → confirm both the deterministic test and `e2e.sh` pass.

## Style

- TS: 4-space indent, no tabs, LF, prettier (`trailingComma: "none"`). YAML/MD use 2-space indent.
- Rust: `rustfmt.toml` enforces 4-space spaces, LF.
- Lint: ESLint for TS, Clippy for Rust, `cargo machete` for unused deps. All wired into `scripts/check.sh`.
