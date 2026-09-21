# Shared sync harness support

Test-only code shared by the deterministic and seeded clients.

| Suite | Coverage |
| --- | --- |
| `harness.test.ts`, `oracle-regressions.test.ts` | Independent content/identity oracles, exercised faults, exclusive operations, persistence ownership, cleanup and seeds |
| `file-application.test.ts` | Swaps, file/directory transitions, visible conflict files, live edits, exclusions, and one metadata save per application |
| `recovery.test.ts` | Interrupt every application filesystem/save boundary, reopen metadata, modify disk, and verify stable ordinary scans; manifest policy and notification identity |
| `engine-regressions.test.ts`, `sync-audit.test.ts` | Offline identities, unknown network outcomes, rejection/retry, exclusions, interrupted in-memory pagination, namespace races and lifecycle changes |
| `event-delivery.test.ts`, `polling.test.ts` | WebSocket hints with HTTP-only event reads, missed notifications, opt-in polling, shutdown and retry |
| `protocol.test.ts` | Abrupt worker termination after accepted requests, exact retries, real server SIGKILL, CAS and event ordering |
| `restart-reconciliation.test.ts` | Interrupted file application followed by user edits, two-client/server convergence and a second restart |
| `server-restore.test.ts` | History checkpoints, server backup restores and interrupted metadata resets |
| `content-limits.test.ts`, `protocol-audit.test.ts` | Content validation and API invariants |
| `real-disk.test.ts` | Host filesystem exclusive create/rename, unsafe links, and rename cycles |

The filesystem interruption tests assert the supported contract: complete metadata
remains usable, scans observe the current files, and a second scan is stable.
They do not demand the pre-interruption file contents, identities or a replay of
unfinished operations. Normal-operation tests still check exact bytes and identities.
There is no filesystem journal or hidden recovery archive.

`MemoryDisk` exposes `before:`, `visible:` and `durable:` boundaries. A process
interruption retains visible changes; a simulated power loss rolls unflushed
changes back. This provides different partial-application states for testing; it
is not an APFS/ext4 writeback model or a production durability requirement.
`MemoryPersistence` atomically replaces complete objects and can reject before or
after replacement. Abandoned filesystem sessions are fenced against later writes.

`crash-worker.ts` runs a complete client in a worker, which the parent terminates
at accepted-response checkpoints without graceful shutdown. A new runtime receives
the saved disk and metadata. The separate real-disk fixture uses a test-only native
exclusive-rename helper and ordinary writes without flushes. It is not a production
adapter or a sandbox against hostile concurrent changes to ancestor directories.

Scripted and seeded suites run multiple clients against real servers. They check
visible bytes, UUID mappings, canonical server state, content heads and event cursors.
Polling is disabled except in tests specifically exercising it. Faults must fire;
missed injections fail cleanup rather than silently passing. Workload traces,
per-worker results and logs are saved by `scripts/e2e.sh` for reproduction.

Run from the repository root:

```sh
E2E_WORKERS=32 E2E_SEED=12 E2E_TIMEOUT_SECONDS=9000 E2E_ITERATIONS=100 scripts/e2e.sh
```

The command rebuilds peers, runs unit/harness/protocol/scripted suites, and then
runs seeds 12 through 43. `E2E_ARTIFACTS` optionally selects the artifact directory.
The runner tests also verify subprocess exit codes, log errors, spawn failures,
timeouts, workspace dependency consistency and CI artifact wiring.
