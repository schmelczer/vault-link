# Sync test harnesses (API v4)

Run the complete harness check from **any working directory**:

```sh
E2E_WORKERS=2 /path/to/vault-link/scripts/e2e.sh
```

The `E2E_WORKERS` variable is the number of fuzz workers / simultaneous scripted tests.
The runner builds the server and the three in-scope frontend packages, then runs
the harness self-tests, recovery regressions, protocol/real-filesystem tests,
scripted scenarios, and seeded fuzz workers. It does not build the Obsidian plugin
or CLI application. Install frontend dependencies with `npm ci` first. Node's
built-in WebSocket, Rust, and a C compiler (`cc`, for test-only exclusive rename
and OS-lock primitives on macOS/Linux) are required.

CI installs those dependencies in `frontend` before invoking the runner. It sets
`E2E_ARTIFACTS=logs/e2e` and uploads that same directory even when a suite fails.
The runner owns all test servers; no separate server or legacy cleanup script is
needed in the workflow.

Each server gets a fresh temporary database, working directory, and port. Only
owned processes are terminated. There is no `pkill`, fixed database deletion,
or shared server PID file. Failing tests and teardown errors give nonzero exits;
the remaining suites still run. Logs, concrete fuzz traces, results, and failure
snapshots are retained in the printed artifact directory. Snapshots are captured
before teardown so cleanup failures retain the original evidence.

Environment options:

- `E2E_WORKERS=1`: number of fuzz workers / simultaneous scripted tests (max 32).
- `E2E_SEED=1`: first uint32 seed; workers use successive seeds.
- `E2E_ITERATIONS=25`: generated conflict scenarios per worker.
- `E2E_TIMEOUT_SECONDS=900`: timeout for each build/suite/worker command.
- `E2E_ARTIFACTS=/absolute/path`: optional output directory; defaults to `mkdtemp`.

## Running individual layers

From `frontend`:

```sh
# Rebuild protocol peers and run scripted tests (name filter optional).
npm run test --workspace deterministic-tests -- --filter v4- --concurrency 2

# Adapter/oracle/lifecycle self-tests and strict recovery regressions.
npm run test:harness

# After rebuilding: real worker death, server SIGKILL/restart, CAS/WS ordering,
# and host filesystem contract checks.
npm run test:protocol

npm run build --workspace sync-client --workspace test-client
node test-client/dist/cli.js --seed 42 --iterations 25
node test-client/dist/cli.js --replay /path/to/trace-42.json
```

`test:harness` includes strict regressions for **engine** bugs.
A failing default run is not an expected-failure test or a harness skip. See
[`../test-support/README.md`](../test-support/README.md) for their scope.

## What the scripted runner checks

Real `SyncClient` instances use the shared v4 adapter in `../test-support`.
External editor operations and engine filesystem operations are separate: engine
writes never generate self-notifications. Editor identity notifications continue
while transport is disabled. Delayed notifications can be explicitly queued and
flushed. Snapshots and persisted state are deep copies, never shared references.

Scripted and seeded clients explicitly set `syncIntervalMs: 0`, with assertions
that it stays disabled. Barriers observe convergence; they do not wake the engine.
Network retry timers remain enabled. Separate fake-clock tests in
`test-support/polling.test.ts` exercise optional periodic reconciliation.

A barrier checks byte-for-byte replica equality **and** the server's canonical
UUID/path map, file bytes, independently computed base/observed hashes, content
and manifest CAS parents, event watermark,
contiguous event log, and absence of pending requests.
Internal recovery files are excluded from the user-visible file list, but are
present in failure disk images. Scenario assertions separately check intended
content, document identity, or preservation markers; equality alone is not an
adequate data-loss oracle.

Clients start disabled. `enable-sync` waits for the initial sync attempt/retries,
except while the server is intentionally paused: that attempt is tracked so a
later script step can resume the server. Thus sequential enables really establish
a winner. To test _independent creates_, first bootstrap both clients empty, then
disable them and create files. Initial adoption of pre-existing files during
bootstrap is a different policy from two already-initialized clients creating
distinct UUIDs at one path.

## Controls and assertions

- `create`, `update`, `create-bytes`, `rename`, `delete`: external editor actions.
  Editor rename may explicitly replace its target; engine rename never may.
- `sync`, `barrier`, `enable-sync`, `disable-sync`.
- `reset`: restart transports; **not** a crash and not a database reset.
- `pause-websocket`, `resume-websocket`: buffer only WS delivery. HTTP catchup
  remains active; this is deliberately not called "disconnect".
- `pause-observation`, `wait-for-observation`, `resume-observation`: explicitly
  gate HTTP catchup as well as WS, including replies already in flight. The
  checkpoint must be exercised and released, and held reads respect cancellation.
- `delay-notifications`, `flush-notifications`: delay editor notifications without
  disabling preservation assertions.
- `drop-response`: `{client, kind: "create" | "content" | "manifest", point:
"before" | "after"}`. After faults fire only on an `Accepted` CAS response.
- `wait-for-response-drop`: explicit checkpoint; every armed fault must fire.
  Every interrupted request must be retried with an identical request ID, target
  and body before a different CAS is sent. Fault kinds match exactly.
- `rename-next-write`: inject an editor rename after the engine's content write,
  before its metadata save.
- `pause-server`, `resume-server`: SIGSTOP/SIGCONT, not a crash.
- `crash-server`, `restart-server`: SIGKILL and restart with the same database/port.
  Server-control scenarios have dedicated processes.
- `remember-identity`, `assert-identity`, `assert-files`, `assert-markers`.
- `assert-documents`: a complete expected set of `{key, path, content, conflict?}`
  records. Content is text or a byte array. Keys bind UUIDs on the first successful
  check and must retain them on later checks; new keys cannot reuse deleted UUIDs.
  `conflict: true` resolves the UUID-derived conflict name for `path`.
- `assert-consistent` can provide `verify(state)`: exact text/bytes, UUID lookups,
  `assertIdentity`, and `conflictPath(original)` for UUID-derived conflict names.

Legacy timing scenarios are retained. Prefer explicit fault checkpoints and
barriers for new tests. Only known coherent-scan races and actually injected
transient network errors may retry; they still must converge before the deadline.
Other background errors, unhandled rejections, and cleanup failures fail the run.

## Reproducibility limits

Seeds and JSON traces reproduce harness choices and logical actions. They do not
control the OS scheduler, server thread scheduling, or production-generated UUIDs.
The recovery sweep enumerates adapter/save boundaries; worker termination proves
abrupt runtime loss. Neither is a proof covering every real filesystem or hardware
power-loss behavior. Run multiple seeds, repeat timing-sensitive cases, and keep
the scenario's independent oracle when reducing a failing trace.
