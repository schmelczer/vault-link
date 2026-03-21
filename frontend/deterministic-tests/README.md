# Deterministic Testing Framework

A framework for defining and running deterministic tests for VaultLink sync operations. Unlike the fuzz testing approach, these tests execute exact sequences of operations to verify specific conflict resolution scenarios.

## Overview

The deterministic testing framework allows you to:

- Define exact sequences of client operations in TypeScript
- Control both client and server processes (pause/resume)
- Test specific conflict scenarios (write/write, rename/create, etc.)
- Verify that the system resolves conflicts consistently

## Architecture

```
┌─────────────────────────────────────────────┐
│          Test Definition (TypeScript)        │
│   - Declare steps sequentially              │
│   - Specify client operations               │
│   - Add assertions                          │
└──────────────┬──────────────────────────────┘
               │
               v
┌─────────────────────────────────────────────┐
│            Test Runner                       │
│   - Initializes clients                     │
│   - Executes steps in order                 │
│   - Manages server lifecycle                │
└──────────────┬──────────────────────────────┘
               │
               ├─→ DeterministicAgent (per client)
               │    └─→ SyncClient
               │
               └─→ ServerControl
                    └─→ sync_server process
```

## Test Definition Format

Tests are defined using the `TestDefinition` interface:

```typescript
interface TestDefinition {
  name: string;
  description?: string;
  clients: number;
  steps: TestStep[];
}
```

### Available Steps

#### File Operations

```typescript
{ type: "create", client: 0, path: "file.md", content: "hello" }
{ type: "update", client: 0, path: "file.md", content: "world" }
{ type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" }
{ type: "delete", client: 0, path: "file.md" }
```

#### Sync Control

```typescript
{ type: "sync", client: 0 }        // Wait for specific client
{ type: "sync" }                   // Wait for all clients
{ type: "barrier" }                // Wait for all pending ops
{ type: "disable-sync", client: 0 }
{ type: "enable-sync", client: 0 }
```

#### Server Control

```typescript
{ type: "pause-server" }           // Pause server process
{ type: "resume-server" }          // Resume server process
{ type: "wait", duration: 500 }    // Wait N milliseconds
```

#### Assertions

```typescript
{ type: "assert-content", client: 0, path: "file.md", content: "hello" }
{ type: "assert-exists", client: 0, path: "file.md" }
{ type: "assert-not-exists", client: 0, path: "file.md" }
{ type: "assert-consistent" }      // All clients have same state
```

## Example Tests

### Write/Write Conflict

Two clients create the same file with different content:

```typescript
export const writeWriteConflictTest: TestDefinition = {
  name: "Write/Write Conflict",
  clients: 2,
  steps: [
    { type: "disable-sync", client: 0 },
    { type: "disable-sync", client: 1 },
    { type: "create", client: 0, path: "A.md", content: "hello" },
    { type: "create", client: 1, path: "A.md", content: "world" },
    { type: "enable-sync", client: 0 },
    { type: "enable-sync", client: 1 },
    { type: "barrier" },
    { type: "wait", duration: 500 },
    { type: "barrier" },
    { type: "assert-consistent" }
  ]
};
```

### Rename/Create Conflict

Client 1 renames A→B while Client 0 creates B:

```typescript
export const renameCreateConflictTest: TestDefinition = {
  name: "Rename-Create Conflict",
  clients: 2,
  steps: [
    { type: "create", client: 0, path: "A.md", content: "hi" },
    { type: "sync", client: 0 },
    { type: "sync", client: 1 },
    { type: "rename", client: 1, oldPath: "A.md", newPath: "B.md" },
    { type: "sync", client: 1 },
    { type: "disable-sync", client: 0 },
    { type: "create", client: 0, path: "B.md", content: "hi" },
    { type: "enable-sync", client: 0 },
    { type: "barrier" },
    { type: "wait", duration: 500 },
    { type: "barrier" },
    { type: "assert-consistent" }
  ]
};
```

## Running Tests

### Build and Run

```bash
# From frontend/deterministic-tests
npm run test
```

### Run Specific Test

```bash
npm run test -- --test write-write-conflict
```

### List Available Tests

```bash
npm run test -- --list
```

### Advanced Options

```bash
# Use custom server binary
npm run test -- --server /path/to/sync_server

# Use custom config
npm run test -- --config /path/to/config.yml

# Don't manage server (assume it's already running)
npm run test -- --no-manage-server
```

## Creating New Tests

1. Create a new test file in `src/tests/`:

```typescript
// my-test.test.ts
import type { TestDefinition } from "../test-definition";

export const myTest: TestDefinition = {
  name: "My Test",
  description: "What this test verifies",
  clients: 2,
  steps: [
    // Your test steps here
  ]
};
```

2. Register the test in `src/cli.ts`:

```typescript
import { myTest } from "./tests/my-test.test";

const TESTS: Record<string, TestDefinition> = {
  // ... existing tests
  "my-test": myTest
};
```

3. Build and run:

```bash
npm run test -- --test my-test
```

## Key Concepts

### Synchronization Points

Use explicit sync barriers to ensure operations complete:

- `{ type: "sync", client: 0 }` - Wait for client 0 to finish pending ops
- `{ type: "barrier" }` - Wait for all clients to finish
- `{ type: "wait", duration: 500 }` - Wait for propagation

### Offline Testing

Disable sync to simulate offline edits:

```typescript
{ type: "disable-sync", client: 0 },
{ type: "create", client: 0, path: "file.md", content: "offline edit" },
{ type: "enable-sync", client: 0 },  // Sync when back online
```

### Server Control

Pause the server to test reconnection:

```typescript
{ type: "pause-server" },
{ type: "create", client: 0, path: "file.md", content: "while paused" },
{ type: "resume-server" },
{ type: "barrier" }
```

### Assertions

Always end tests with consistency checks:

```typescript
{
  type: "assert-consistent";
} // Verify all clients converged
```

## Troubleshooting

### Server Won't Start

- Ensure server is built: `cd sync-server && cargo build`
- Check config file exists: `sync-server/config-e2e.yml`
- Verify port 3000 is available

### Test Hangs

- Increase wait durations for slow systems
- Add more `{ type: "barrier" }` steps
- Check server logs for errors

### Assertion Failures

- Add `{ type: "wait", duration: 1000 }` before assertions
- Check if conflict resolution is working as expected
- Review test steps for logic errors

## Comparison to Fuzz Tests

| Aspect          | Fuzz Tests      | Deterministic Tests       |
| --------------- | --------------- | ------------------------- |
| Operations      | Random          | Explicit sequence         |
| Reproducibility | Difficult       | Perfect                   |
| Coverage        | Broad           | Targeted                  |
| Debugging       | Hard            | Easy                      |
| Use Case        | Find edge cases | Verify specific scenarios |

Use both approaches:

- Fuzz tests for discovering unexpected issues
- Deterministic tests for verifying specific fixes
