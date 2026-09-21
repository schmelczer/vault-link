# Seeded sync workloads

The old random mock filesystem/agent have been replaced by the same v4 adapter,
client wrapper, and canonical-state assertions as the scripted suite.
Periodic polling is explicitly disabled so it cannot repair missed notifications
and hide failures in these workloads. Polling has separate fake-clock tests.

From `frontend`:

```sh
npm run build --workspace sync-client --workspace test-client
node test-client/dist/cli.js --seed 42 --iterations 25
node test-client/dist/cli.js --replay /path/to/trace-42.json
```

The server binary must already be built. Each invocation starts and cleans up its
own server/database, and prints the replay command before executing any actions.
`--artifacts` chooses the trace/result directory. Failures include database,
visible/durable disk images, and CAS request records. The default 25 iterations
are scenarios selected in shuffled cycles of nine operations, using two or three
clients. Existing documents are repeatedly edited, moved, swapped, deleted and
recreated. Concurrent edits share an established base; delayed editor events stay
queued through reconnection and a subsequent remote edit. Create, content-update
and manifest requests receive before/after network faults.

Each checkpoint serializes a complete expected file set with exact bytes, paths
and persistent identity keys. Independent creates must remain distinct, and a
recreated file must obtain a new UUID. Later checkpoints reassert earlier edits
and moves, rather than retaining only their markers. Old traces without a client
count still replay with two clients.

All preservation assertions run even with delayed editor events. Explicit deletes
and overwrites exempt only their specific markers; unrelated content still must
appear exactly once. UUID continuity and canonical server state are checked too.
Seeds reproduce choices, not OS scheduling. See the
[full harness documentation](../deterministic-tests/README.md).
