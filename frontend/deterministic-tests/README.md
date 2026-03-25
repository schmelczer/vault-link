# Deterministic Tests

Scripted multi-client (with an in-memory filesystem) sync tests that run against a real server. Each test defines a sequence of file operations, sync/server controls, and assertions to exercise a specific conflict or edge case.

Complements the fuzz-based E2E tests (`test-client`): fuzz tests discover bugs through random operations; deterministic tests pin down exact reproduction sequences for known scenarios.

## How it works

Each test is a `TestDefinition`: a name, a client count, and an ordered list of steps. The `TestRunner` spins up N `DeterministicAgent` instances (each wrapping a real `SyncClient` with an `InMemoryFileSystem`) pointed at a shared vault on the server, then executes steps one by one.

Tests that don't pause the server share a single server process (vault-name isolation). Tests that use `pause-server`/`resume-server` (SIGSTOP/SIGCONT) each get a dedicated server, since SIGSTOP freezes the entire process.

All tests run in parallel up to a concurrency limit.

## Step types

Clients always start with syincing being disabled.

**File operations** (per-client, fire-and-forget — sync is enqueued but not awaited):
- `create`, `update`, `rename`, `delete`

**Sync control:**
- `sync` — wait for a specific client or all clients to finish pending operations
- `barrier` — retry until all clients converge to identical file state (60s timeout)
- `enable-sync` / `disable-sync` — simulate going online/offline

**Server control:**
- `pause-server` / `resume-server` — SIGSTOP/SIGCONT the server process
- `wait` — sleep for N milliseconds

**Assertions:**
- `assert-content`, `assert-exists`, `assert-not-exists`
- `assert-consistent` — all clients have identical files; optionally takes a custom verify function

## Running

```sh
# Build server first
cd sync-server && cargo build --release

# Run all tests
cd frontend && npm run test -w deterministic-tests

# Filter by name
npm run test -w deterministic-tests -- --filter=rename

# Control parallelism (default: number of CPU cores)
npm run test -w deterministic-tests -- -j 4
```

## Adding a test

1. Create `src/tests/my-scenario.test.ts`:

```typescript
import type { TestDefinition } from "../test-definition";

export const myScenarioTest: TestDefinition = {
    name: "My Scenario",
    description: "What this test verifies",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "hello" },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-consistent" }
    ]
};
```

2. Register it in `src/test-registry.ts`:

```typescript
import { myScenarioTest } from "./tests/my-scenario.test";

const TESTS = {
    // ...
    "my-scenario": myScenarioTest
};
```

