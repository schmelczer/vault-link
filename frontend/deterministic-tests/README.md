# Deterministic Tests

Scripted multi-client (with an in-memory filesystem) sync tests that run against a real server. Each test defines a sequence of file operations, sync/server controls, and assertions to exercise a specific conflict or edge case.

Complements the fuzz-based E2E tests (`test-client`): fuzz tests discover bugs through random operations; deterministic tests pin down exact reproduction sequences for known scenarios.

## How it works

Each test is a `TestDefinition`: a client count and an ordered list of steps. The test name is derived from the registry key (which matches the file name). The `TestRunner` spins up N `DeterministicAgent` instances (each wrapping a real `SyncClient` with an `InMemoryFileSystem`) pointed at a shared vault on the server, then executes steps one by one.

Tests that don't pause the server share a single server process (vault-name isolation). Tests that use `pause-server`/`resume-server` (SIGSTOP/SIGCONT) each get a dedicated server, since SIGSTOP freezes the entire process.

The runner executes two sequential phases: regular tests on the shared server, then pause-server tests on dedicated servers. Within each phase tests run in parallel up to a concurrency limit.

## Step types

Clients always start with syncing disabled.

**File operations** (per-client, fire-and-forget — sync is enqueued but not awaited):

- `create`, `update`, `rename`, `delete`
- `rename-next-write` — arm a deferred rename that fires the next time the given path is written. Lets a test race a user-rename against an in-flight remote create that's about to land at the same path.

**Sync control:**

- `sync` — wait for a specific client or all clients to finish pending operations
- `barrier` — retry until all clients converge to identical file state (60s timeout)
- `enable-sync` / `disable-sync` — simulate going online/offline
- `reset` — reset a client's tracked sync state (keeps disk files); equivalent to a forced re-handshake on next enable
- `sleep` — wall-clock pause; use sparingly, prefer `barrier` / `sync`

**WebSocket control** (per-client):

- `pause-websocket` / `resume-websocket` — buffer/release WebSocket messages for a specific client

**Server control:**

- `pause-server` / `resume-server` — SIGSTOP/SIGCONT the server process
- `resume-server-until-history-then-pause` — resume the server, wait until a specific client observes a matching history entry (`CREATE`/`UPDATE`/`DELETE` for a path), then re-pause. Used to land exactly one operation across the wire.

**Fault injection** (per-client):

- `drop-next-create-response` — arm a one-shot interceptor that lets the next `POST /documents` reach the server (commit happens) but throws `SyncResetError` before the client sees the response, simulating connection loss after server commit.
- `wait-for-dropped-create-response` — wait until the armed drop has fired.

**Assertions:**

- `assert-consistent` — all clients have identical files; optionally takes a custom `verify(state: AssertableState)` callback

## Running

```sh
# Build server first
cd sync-server && cargo build --release && cd -

# Build the client
cd frontend && npm run build -w sync-client

# Run the tests filtering by name with concurrency
npm run test -w deterministic-tests -- --filter=rename -j 4
```

## Adding a test

1. Create `src/tests/my-scenario.test.ts`:

```typescript
import type { TestDefinition } from "../test-definition";

export const myScenarioTest: TestDefinition = {
  description:
    "Client 0 creates A.md offline. After syncing, both clients should have the file.",
  clients: 2,
  steps: [
    { type: "create", client: 0, path: "A.md", content: "hello" },
    { type: "enable-sync", client: 0 },
    { type: "enable-sync", client: 1 },
    { type: "barrier" },
    {
      type: "assert-consistent",
      verify: (s) => {
        s.assertFileCount(1).assertContent("A.md", "hello");
      }
    }
  ]
};
```

The `verify` callback receives an `AssertableState` object with chainable assertion methods:

```typescript
s.assertFileCount(n);                       // exact file count
s.assertFileExists("path");                 // file must exist
s.assertFileNotExists("path");              // file must not exist
s.assertContent("path", "expected");        // exact content match
s.assertContains("path", "a", "b");         // all substrings present in file
s.assertContainsAny("path", "a", "b");      // at least one substring present
s.assertAnyFileContains("text");            // substring present in some file
s.assertNoFileContains("text");             // substring absent from every file
s.assertSubstringCount("path", "x", 3);     // substring appears exactly N times
s.assertContentInAtMostOneFile("text");     // no duplicate content
s.ifFileExists("path", (s) => { /* … */ }); // conditional block
s.getContent("path");                       // raw content (or "" if missing)
```

2. Register it in `src/test-registry.ts`:

```typescript
import { myScenarioTest } from "./tests/my-scenario.test";

const TESTS = {
  // ...
  "my-scenario": myScenarioTest
};
```
