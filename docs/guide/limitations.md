# Limitations

VaultLink works well for most Obsidian vaults, but has some constraints you should know about.

## File Type Limitations

### Mergeable Files

Only **`.md`** and **`.txt`** files get automatic conflict-free merging.

For other file types, a one-sided change is retained. Concurrent unmergeable
changes keep the server's version. The client does not archive displaced bytes.

### Binary Detection

Files are treated as binary if they:

- Contain NUL bytes (`0x00`)
- Fail UTF-8 validation

Binary files within `.md` or `.txt` extensions follow the same unmergeable-content policy.

## Performance Constraints

### Server Limits (Configurable)

| Resource                 | Default | Maximum Tested |
| ------------------------ | ------- | -------------- |
| Clients per vault        | 256     | ~256           |
| Database connections     | 12      | 20             |
| Max file size            | 512 MB  | 4096 MB        |
| Request timeout          | 60s     | 180s           |
| WebSocket cursor timeout | 60s     | 300s           |
| Database busy timeout    | 3600s   | -              |

### Vault Size

- **Small vaults** (< 1000 files): Excellent performance
- **Medium vaults** (1000-10000 files): Good performance
- **Large vaults** (> 10000 files): Works, but initial sync slower

No hard file count limit—constrained by disk space and sync time.

### Resource Usage

Rough estimates (varies by vault size and activity):

- **RAM**: ~50-200 MB base + ~1-5 MB per active client
- **CPU**: Low (< 5%) for typical usage, spikes during merges
- **Disk**: Vault size + version history (grows over time)

## Version History

### Storage

- All versions stored indefinitely (no automatic cleanup)
- Each vault is a separate SQLite database
- Deletion removes file-manifest membership; content history remains readable

**Growth**: Version history grows with every change. A 10 MB vault with frequent edits might grow to 100+ MB over months.

Immutable merge bases and request receipts must not be independently deleted. There is no automatic safe history-pruning protocol.

### Implications

- Disk usage grows over time
- Database size affects backup time
- No built-in retention policy

## Merge Quality

### Text Merging

VaultLink uses word-level tokenisation for merging:

```markdown
Parent: "The quick brown fox"
User A: "The quick red fox"
User B: "The very quick brown fox"
Result: "The very quick red fox" ← Both changes preserved
```

**Imperfect scenarios**:

- Complex nested Markdown (tables, code blocks)
- Simultaneous edits to the same sentence
- Large structural changes (moving sections around)

Merged files may require manual review; there is no measured universal conflict-success rate.

## Scalability

### SQLite Limitations

- One SQLite database per vault
- Single-server architecture (no built-in clustering)
- Write serialisation through database

**For high concurrency**: Consider multiple vaults instead of one massive shared vault.

### Horizontal Scaling

Not currently supported. Running multiple servers requires manual vault partitioning.

## Network Requirements

### Latency

- Real-time sync typically < 500ms on good connections
- Mobile/slow networks: 1-5s latency possible
- Timeout failures on very slow connections (> 60s)

### Offline Behaviour

- Clients queue changes locally
- On reconnect, sync all changes since last connection
- Conflicts resolved automatically (for mergeable files)

**Limitation**: No offline conflict preview—merged result appears after reconnect.

## Security

### No End-to-End Encryption

- Server sees all file contents
- Transport encryption only (WSS/TLS)
- Trust your server

**Workaround**: Self-host on infrastructure you control.

### Authentication

- Token-based only (no OAuth, SAML, etc.)
- Tokens configured in server config file
- No runtime user management

## Restored backups

Restore server databases while the server is stopped. API v5 clients detect a
changed history even when version numbers are reused. Clean files reconcile with
the restored server; unsent edits are preserved as separate local documents.
Clients and server must be upgraded together. This does not replace independent
backups or protect against arbitrary physical-media corruption.

## Interrupted sync

The client has no filesystem journal or power-loss durability protocol. Interrupted
writes may leave missing, partial or moved files. On restart, normal scans reconcile
the current files, including edits made while the client was stopped. Metadata
saves must remain complete and readable, so the client can continue syncing; exact
pre-interruption file contents and identities are not guaranteed.

## Known Edge Cases

### Simultaneous Deletes and Edits

```
User A deletes note.md
User B edits note.md
Result: Manifest deletion removes the file, including unsent local edits.
```

Content updates do not restore deleted membership. There is no local recovery archive.

### Large File Uploads

Files > 100 MB may time out on slow connections. Increase `response_timeout_seconds` or split large files.

### Mobile Sync

- Mobile networks may drop WebSocket connections frequently
- Client auto-reconnects, but causes sync delays
- Battery impact from constant reconnections

## What VaultLink is NOT

- **Not a backup solution**: Version history helps but isn't a backup (make backups!)
- **Not Git**: No branching, no commit messages, no diffs to review before merge
- **Not encrypted storage**: Server sees everything
- **Not multi-master**: One server, multiple clients (not peer-to-peer)

## Recommendations

### Good Use Cases

- Personal multi-device sync (< 10 devices)
- Small team collaboration (< 20 people)
- Primarily text/Markdown content
- Trusted server environment

### Poor Use Cases

- Large teams (> 50 concurrent users per vault)
- Primarily binary files (images, videos, large PDFs)
- Untrusted server (need E2E encryption)
- Highly regulated environments (HIPAA, etc.)

## Next Steps

- [Server configuration limits →](/config/server)
- [Advanced tuning →](/config/advanced)
- [Architecture details →](/architecture/)
