# Shared sync harness support

This is test-only code, shared by `deterministic-tests` and `test-client` rather
than exported as debugging machinery by the production sync client.

The journal suites also cover repeated saves replacing earlier unsynced text,
tracked file/directory moves into ignored paths, and saves crossing the size
limit. They check exact bytes and identities through recovery, including real
server reads. Client and Rust unit suites bound deep-path validation resources.

| Layer                        | What it establishes                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness.test.ts`            | Divergence/self-comparison detection, binary-safe comparisons, marker loss/duplication, cleanup failure propagation, deep persistence ownership, exclusive operations, exercised faults, seed reproducibility                    |
| `oracle-regressions.test.ts` | Negative checks for regenerated retries, wrong fault kinds, duplicate clients, corrupt hashes, BOMs, path byte limits, idempotent unlink, directory durability, and complete identity/content expectations                       |
| `recovery.test.ts`           | Real engine journal recovery at every enumerated apply and replay mutation/save boundary; two interruptions followed by another power loss; identity, retained bytes and merge-policy regressions                                |
| `engine-regressions.test.ts` | Recovery archives, offline notifications, rejection/retry, exclusions, reverted remote updates, lifecycle races and editor changes during staging/install                                                                        |
| `event-delivery.test.ts`     | Real sync loop with checkpoint-controlled WS bursts before an iteration and during event application; no polling or extra wakeups to hide queued events                                                                          |
| `polling.test.ts`            | Real sync loop with fake clocks: missed local/remote notifications, disabled controls, repeated polls, shutdown and network retries independent of polling                                                                       |
| `protocol.test.ts`           | Terminated worker runtimes after accepted creates, existing-document Snapshot/Diff updates, and manifest requests, exact durable retries after newer remote heads and real server SIGKILL; concurrent CAS and ordered WS catchup |
| `real-disk.test.ts`          | Host filesystem exclusive create/rename, symlink/hardlink rejection and a real engine rename-cycle application                                                                                            |
| Scripted suite               | Existing multi-client regression scenarios plus v4 binary, identity, path-conflict, retry, and server-restart cases                                                                                                              |
| Seeded workloads             | Concrete replay traces, offline and rapid online moves/edits, concurrent creates, exact deletion/overwrite exemptions, nested Unicode paths, delayed notifications and before/after network failures                             |

`scripts/e2e-runner.test.mjs` also guards clean-install workspace/lockfile
consistency, CI dependency installation and artifact upload wiring, subprocess
exit codes, log failures, spawn failures, and timeouts.

`MemoryDisk` distinguishes visible namespace/data from durable entries. Each
mutation has `before:`, `visible:`, and `durable:` boundaries. `crash(false)`
models process death with dirty kernel state retained; `crash(true)` discards
unflushed state. Operations that return successfully have flushed their affected
entries. Idempotent unlink flushes absent entries too, and durable directory
removal makes all former descendants unreachable. This is a deliberately small atomic-operation model, not an emulation
of APFS/ext4 writeback. A crashed session is fenced against subsequent writes.

`MemoryPersistence` atomically saves complete, cloned objects. Failure before a
save leaves the old object; failure after durable replacement leaves the new one.
The journal sweep recreates the production database/file-operations objects after
each fault. From each interrupted state it traces recovery and injects a second
process death or power loss at every replay mutation/save boundary. Final recovery
is replayed again and followed by another power loss. Cases cover swaps with new
output, cross-directory moves with a surviving sibling, concurrent text merges,
binary replacement, deletion and recovery archive cleanup. Exact visible bytes,
UUID/path mappings, retained bytes and absence of transaction files are checked. An intent is resubmitted only if nothing was durably saved;
resubmitting a partially recovered operation would hide journal defects.

`crash-worker.ts` runs a complete SyncClient in a separate worker. The parent
terminates it at an explicit accepted-response checkpoint without `destroy()`;
no old timers, websocket handlers, or promises survive. Update cases bootstrap an existing UUID and assert the non-null parent and exact
Snapshot/Diff request type before termination. Its saved memory-disk image and persisted database seed a fresh runtime. The separate real-disk fixture
uses a test-only native exclusive-rename primitive. It is **not** a
production adapter or an adversarial `openat` sandbox: concurrent hostile changes
to ancestor directories and actual machine power cuts are outside its coverage.

## Regression coverage

The previously exposed WS queue, notified-rename UUID, uncertain-save replay,
and cross-directory durability failures are fixed and remain asserted by the
default harness. Scripted, seeded, event-delivery and engine regression clients
explicitly disable polling so it cannot hide a missing wakeup. Crash workers also
assert that this setting survives restart. Polling is enabled only in separate
tests that intentionally omit notifications and advance a fake clock. Identity
assertions distinguish documents even when bytes
are equal. The engine regressions additionally exercise retained recovery bytes,
durable offline notifications, permanently rejected requests, ignored namespace
conflicts, reverted remote updates, and concurrent lifecycle changes.

Tests assert intended invariants, including bytes and UUID mappings, rather than
accepting the observed output as an oracle. The memory fault model and real-disk
checks complement one another; neither proves behavior under every real power cut.

## September 2026 audit regressions

`scripts/e2e.sh` now runs the Rust and client unit suites as well as the harness,
real-server protocol checks, scripted scenarios, and seeded workloads. A failing
unit suite makes the complete run fail. The audit tests are separate, individually
quoted arguments in the default scripts, with a runner regression guarding that wiring.

The audit cases were first run with assertions for the required behavior and
observed failing before the corresponding fixes. Coverage is organized by the
original finding numbers:

| Findings | Permanent coverage and resulting guarantee                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Engine and real-server lost-reply/rejected-retry tests preserve later content and rename undos; interrupted receipt saves and paged replay are tested after process replacement.                                                                                                   |
| 2, 6     | Ignored/oversized unmanaged occupants keep their paths, including arrivals after scanning; submitted manifests reserve excluded server paths and remain valid.                                                                                                                     |
| 3, 12    | Oversized remote heads defer uploads; oversized local files are rejected before snapshot reads; scans retain hashes rather than encoded vault contents; content notifications cannot starve namespace scans.                                                                       |
| 4        | A subprocess deadline detects synchronous conflict-allocation hangs caused by long extensions.                                                                                                                                                                                     |
| 5        | Persistent destination errors select a durable root fallback. The recovery sweep keeps that error active through every first and second crash boundary, checking exact bytes, identities and retained originals.                                                                   |
| 7–9      | Bootstrap notifications adopt remote identities; settings updates resume enabled engines, disabling sync persists across reset, and initial vault bindings survive restart; disabled startup recovers local journals. |
| 10–11    | Fake-clock silent-socket recovery and real-server connection admission, slot release and handshake expiry.                                                                                                                                                                         |
| 13       | Rust tests bound event count and aggregate bytes per page; client tests fold remote reversions before application and preserve the replay position across restart.                                                                                                                 |
| 14–15    | Metadata-only manifest reference validation and active-pool cleanup tests ensure unrelated payload decoding and checked-out transactions cannot block these operations.                                                                                                            |
| 16       | Dirty cursor updates invalidate precise positions; disconnect/reset clear presented cursors.                                                                                                                                                                                       |
| 17       | Read-only configuration preservation and concurrent initialization verify that existing credentials are never rewritten or replaced.                                                                                                                                               |

The follow-up audit added these independently reproduced failures. Each behavior
was asserted before its fix; the default test commands include every regression.

| Additional failure                                                  | Regression coverage                                                                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delayed content receipts crash after local deletion                 | `sync-audit.test.ts` verifies receipt consumption, preserved deletion, and cursor advancement without a local path.                                                                  |
| Cursor reads restore presence after disconnect/reset                | Cursor unit tests hold an active read and queue another update, retire the connection, then release both.                                                                            |
| Failed WebSocket upgrades strand clients with polling disabled      | `polling.test.ts` requires exact remote content and rename catchup over HTTP after a disconnect signal.                                                                              |
| WebSocket construction errors escape startup/retry callbacks        | Transport unit tests fail the first or second construction and require a successful subsequent connection.                                                                           |
| Opening a locked vault blocks unrelated vaults                      | Rust tests hold a real SQLite writer lock during lazy opening; another vault must remain readable. Concurrent openings must share the configured pool, including after cancellation. |
| Failure clearing rejected requests leaves an enabled client stopped | Settings tests fail the second save, before and after commit, and require later notifications to wake synchronization.                                                               |
| Caller mutations bypass the checked settings snapshot               | A settings test changes the caller's vault name and exclusion array while transports pause; persisted settings must retain the original input.                                       |
| Cursor freshness uses metadata captured before an asynchronous read | A cursor test advances the document while the read is suspended and requires the old cursor to be marked outdated.                                                                   |
| Throwing/silent socket closes leave live handlers after shutdown    | Transport tests require disconnected status and no message delivery after a failed or timed-out close.                                                                               |
| Handshake send errors escape the socket-open callback               | A transport test drops the send during opening and requires safe retirement and retry.                                                                                               |
| Old connection cleanup deletes its replacement's cursors            | A real-server overlapping reconnect test preserves the replacement; Rust tests also reject delayed updates from the old session.                                                     |

These cases exercise transitions the earlier tests did not combine: a deletion
between submission and acknowledgement, disconnects during reads, failures after
the settings save, and two connections sharing a device identity. Happy-path
reconnect and single-save fault tests do not establish those guarantees.

Replay pages contain at most 64 events and approximately 1 MiB of aggregate event
JSON. One atomic manifest can exceed that budget; it is sent alone so replay still
advances. `endEventId` identifies the page boundary while `headEventId` identifies
the vault head. Deploy the updated client and server together: older clients
require each batch to reach the vault head. Local partial replay folds retain only
latest document heads, the latest manifest, and matching outstanding receipts;
local files are reconciled only when catchup reaches the head.

Permanent destination failures use `Recovered <document ID><extension>` in the
vault root, resolving any occupied name. The journal retains the original bytes
when content is replaced. Permission or storage failures that also prevent that
fallback remain explicit recovery failures with the journal intact.

A rejected retry retains an unconfirmed receipt until its request appears in the
event log. Absence from one catchup is not proof that an earlier in-flight attempt
cannot still commit. Receipt/artifact pruning remains an explicit operational concern; these tests do not claim
formal completeness or simulate arbitrary physical-media corruption.

Reproduce the complete validation run from the repository root:

```sh
E2E_ITERATIONS=100 E2E_SEED=8201 E2E_WORKERS=2 scripts/e2e.sh
```

## Sync regression coverage added after the September audit

The normal test commands include these regressions:

| Failure                                                                                     | Maintained coverage                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ignored occupant renamed into scope; incoming download discarded by unrelated notifications | `journal-protocol.test.ts` checks visible files, original IDs and actual server content.                                                                                                                                    |
| Source path reused or moved during staging; editor save becomes a duplicate                 | `journal-interleavings.test.ts` injects moves, delete/recreate, move/recreate and content saves at every enumerated read, mutation and state-save boundary. Assertions specify bytes and document identities independently. |
| Journal/editor interaction followed by a crash                                              | `journal-protocol.test.ts` crosses three editor operations with failures before/after state persistence, process replacement and simulated power loss, then checks another reset.                                           |
| Restored server history falsely appears current                                             | `server-restore.test.ts` restores actual SQLite backups and restarts Rust, covering equal/lower counters, dirty files, lost acknowledgements, interrupted recovery saves and old client state without checkpoints.          |
| Oversized remote fallback and stale responses                                               | `content-limits.test.ts` measures payload downloads, checks metadata-only responses and verifies highly fragmented local edits fall back to snapshots.                                                                      |
| Adversarial diff work                                                                       | Rust endpoint tests reject excessive operations without appending events and exercise Unicode reconstruction.                                                                                                               |
| Observer exception kills sync                                                               | `observer.test.ts` runs throwing/rejecting subscribers in a child process and verifies a second sync; listener unit tests verify continued delivery.                                                                        |
| Outgoing cursor version race                                                                | `outgoing-cursor.test.ts` changes version, identity, path and existence during a read, deliberately including identical bytes.                                                                                              |
| Unpersisted credentials                                                                     | Rust config tests reject both missing users and missing user lists while preserving existing file bytes; initialization tests verify stable saved defaults.                                                                 |
| Extensionless filenames enable merging                                                      | Extension unit tests include root/nested `md` and `txt` and dots in ancestor directories.                                                                                                                                   |
| Corrupt vault blocks startup                                                                | Rust database regression opens a healthy vault alongside an invalid SQLite file and verifies the invalid file remains untouched.                                                                                            |

The filesystem sweep reports the number of boundaries and injected interleavings.
A passing sweep covers this adapter model and these operations; arbitrary physical
media corruption and every possible editor/OS behavior remain outside its scope.
