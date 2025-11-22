# Comparison with Alternatives

VaultLink is one of several solutions for synchronizing Obsidian vaults. This page compares VaultLink with popular alternatives to help you choose the right tool.

## Key Differentiator: Editor Agnostic

**VaultLink is not tied to Obsidian.** While it includes an Obsidian plugin for convenience, VaultLink synchronizes plain text files and works with any editor:

- Edit with **Obsidian desktop** on your laptop
- Edit with **Vim** on your server
- Edit with **VS Code** on your workstation
- Edit with **Obsidian mobile** on your phone
- Use the **CLI client** for automated workflows

All changes merge automatically without conflict markers, regardless of which editor you use. This is possible because VaultLink uses [reconcile-text](/architecture/sync-algorithm#why-reconcile-text-over-crdts) for differential synchronization rather than requiring operation-level tracking.

## VaultLink's Core Strengths

Before diving into comparisons:

1. **Fully self-hosted**: Server and all components are open source
2. **Collaborative editing**: Real-time sync with operational transformation
3. **Automatic conflict resolution**: No manual intervention or paid features required
4. **Cursor tracking**: See where other users are editing
5. **Extensively tested**: Comprehensive test suite for server and client
6. **Editor freedom**: Use any text editor, not just Obsidian
7. **Production-ready**: Docker images, health checks, monitoring

## Obsidian Sync Alternatives

### Self-hosted LiveSync

**Downloads**: ~300,000
**Repository**: https://github.com/vrtmrz/obsidian-livesync

**Overview**: CouchDB/IBM Cloudant-based sync with end-to-end encryption.

| Aspect                    | Self-hosted LiveSync        | VaultLink                              |
| ------------------------- | --------------------------- | -------------------------------------- |
| **Self-hosted**           | Yes (CouchDB required)      | Yes (single binary or Docker)          |
| **Conflict resolution**   | Manual or automatic (basic) | Automatic (operational transformation) |
| **Collaborative editing** | No                          | Yes (real-time with cursors)           |
| **Editor support**        | Obsidian only               | Any text editor                        |
| **Infrastructure**        | CouchDB database            | SQLite (bundled)                       |
| **Deployment complexity** | Medium (external DB)        | Low (single container)                 |
| **End-to-end encryption** | Yes                         | No (transport encryption only)         |
| **Out-of-band edits**     | Limited support             | Full support (edit with any tool)      |

**When to use LiveSync**:

- Need end-to-end encryption
- Already running CouchDB
- Only use Obsidian (no external editors)

**When to use VaultLink**:

- Want collaborative editing with multiple users
- Edit files with various tools (Vim, VS Code, etc.)
- Need simpler deployment (no external database)
- Want operational transformation for better merges

---

### Remotely Save

**Downloads**: ~1.1M
**Repository**: https://github.com/remotely-save/remotely-save

**Overview**: Sync to cloud storage providers (S3, Dropbox, OneDrive, WebDAV).

| Aspect                    | Remotely Save                | VaultLink                |
| ------------------------- | ---------------------------- | ------------------------ |
| **Self-hosted**           | Partial (uses cloud storage) | Fully self-hosted        |
| **Conflict resolution**   | Paid Pro feature             | Free and automatic       |
| **Collaborative editing** | No                           | Yes                      |
| **Editor support**        | Obsidian only                | Any text editor          |
| **Storage backend**       | Cloud providers              | Self-hosted SQLite       |
| **Cost**                  | Free (basic) / Paid (Pro)    | Free (open source)       |
| **Code quality**          | No tests, complex codebase   | Comprehensive test suite |
| **Real-time sync**        | No (periodic polling)        | Yes (WebSocket)          |

**When to use Remotely Save**:

- Already use cloud storage (S3, Dropbox)
- Don't need real-time sync
- Single-user scenario

**When to use VaultLink**:

- Want full control over data
- Need automatic conflict resolution without paying
- Want real-time collaborative editing
- Value code quality and testing

**Note**: Remotely Save's conflict resolution is a paid feature. VaultLink provides superior automatic merging for free.

---

### Relay

**Downloads**: ~24,000
**Repository**: https://github.com/No-Instructions/Relay

**Overview**: CRDT-based sync with proprietary server component.

| Aspect                     | Relay                        | VaultLink               |
| -------------------------- | ---------------------------- | ----------------------- |
| **Self-hosted**            | No (proprietary server)      | Yes (fully open source) |
| **Conflict resolution**    | CRDT (automatic)             | OT (automatic)          |
| **Collaborative editing**  | Yes                          | Yes                     |
| **Editor support**         | Obsidian only                | Any text editor         |
| **Out-of-band edits**      | No (breaks CRDT consistency) | Yes (differential sync) |
| **Server open source**     | No                           | Yes                     |
| **Infrastructure control** | Limited                      | Full                    |
| **Per-file overhead**      | High (CRDT metadata)         | Low (version history)   |

**When to use Relay**:

- Want hosted solution (don't self-host)
- Only edit within Obsidian
- Don't need out-of-band editing

**When to use VaultLink**:

- Need fully open source solution
- Want to self-host completely
- Edit files outside Obsidian (Vim, VS Code)
- Value infrastructure control

**Critical limitation**: Relay's CRDT approach requires tracking every operation within Obsidian. Editing files outside Obsidian breaks the CRDT state. VaultLink's differential sync works regardless of how files are edited.

---

### Obsidian Git

**Downloads**: ~1.4M
**Repository**: https://github.com/denolehov/obsidian-git

**Overview**: Uses Git for version control and synchronization.

| Aspect                    | Obsidian Git                  | VaultLink               |
| ------------------------- | ----------------------------- | ----------------------- |
| **Self-hosted**           | Yes (Git server)              | Yes (sync server)       |
| **Conflict resolution**   | Manual (conflict markers)     | Automatic (no markers)  |
| **Collaborative editing** | No                            | Yes (real-time)         |
| **Editor support**        | Any (it's Git)                | Any (differential sync) |
| **Version history**       | Full Git history              | Document versions       |
| **Real-time sync**        | No (commit-based)             | Yes (instant)           |
| **Merge conflicts**       | Manual resolution             | Automatic               |
| **Learning curve**        | High (Git knowledge required) | Low                     |
| **Workflow interruption** | Yes (resolve conflicts)       | No                      |

**When to use Obsidian Git**:

- Need full version control (branches, tags, etc.)
- Already familiar with Git workflows
- Want integration with existing Git repos
- Don't mind manual conflict resolution

**When to use VaultLink**:

- Want automatic conflict-free merging
- Need real-time collaborative editing
- Don't want workflow interruptions from merge conflicts
- Prefer simpler mental model (sync, not commits)

**Key difference**: Git requires manual conflict resolution with `<<<<<<<` markers. VaultLink automatically merges all changes using operational transformation, never interrupting your workflow.

---

### Syncthing Integration

**Downloads**: ~22,600
**Repository**: https://github.com/LBF38/obsidian-syncthing-integration

**Overview**: Wrapper around Syncthing for file synchronization.

| Aspect                    | Syncthing Integration          | VaultLink         |
| ------------------------- | ------------------------------ | ----------------- |
| **Self-hosted**           | Yes (Syncthing)                | Yes (sync server) |
| **Conflict resolution**   | Manual                         | Automatic         |
| **Collaborative editing** | No                             | Yes               |
| **Editor support**        | Any                            | Any               |
| **Status**                | Unfinished                     | Production-ready  |
| **Conflict files**        | Creates `.sync-conflict` files | No conflict files |
| **Real-time sync**        | Yes                            | Yes               |
| **Automatic merging**     | No                             | Yes               |

**When to use Syncthing Integration**:

- Already use Syncthing for other files
- Don't need automatic conflict resolution
- Single-user with multiple devices

**When to use VaultLink**:

- Want automatic conflict resolution
- Need collaborative editing
- Want production-ready solution
- Don't want to manage conflict files

**Status note**: Syncthing Integration is marked as unfinished. VaultLink is production-ready with comprehensive testing.

---

### Remotely Sync

**Downloads**: ~38,000
**Repository**: https://github.com/sboesen/remotely-sync

**Overview**: Similar to Remotely Save, syncs to cloud storage.

| Aspect                  | Remotely Sync           | VaultLink           |
| ----------------------- | ----------------------- | ------------------- |
| **Self-hosted**         | Partial (cloud storage) | Fully self-hosted   |
| **Conflict resolution** | Limited/Paid            | Free and automatic  |
| **Code quality**        | No tests                | Comprehensive tests |
| **Maintenance**         | Low activity            | Active development  |

**Same concerns as Remotely Save**: No test suite, conflict resolution limitations, cloud storage dependency.

**When to use VaultLink**: See Remotely Save comparison above.

---

### SyncFTP

**Downloads**: ~5,000
**Repository**: https://github.com/alex-donnan/SyncFTP

**Overview**: Simple FTP-based file synchronization.

| Aspect                    | SyncFTP                | VaultLink        |
| ------------------------- | ---------------------- | ---------------- |
| **Conflict resolution**   | None (last write wins) | Automatic (OT)   |
| **Data loss risk**        | High (overwrites)      | None (merges)    |
| **Collaborative editing** | No                     | Yes              |
| **Sophistication**        | Minimal                | Production-grade |

**When to use SyncFTP**: Don't use SyncFTP for any scenario where data integrity matters.

**When to use VaultLink**: Any scenario requiring reliable synchronization.

---

## Feature Comparison Matrix

| Feature                           | VaultLink | LiveSync | Relay | Git | Remotely Save | Syncthing |
| --------------------------------- | --------- | -------- | ----- | --- | ------------- | --------- |
| **Fully open source**             | ✅        | ✅       | ❌    | ✅  | ✅            | ✅        |
| **Self-hosted**                   | ✅        | ✅       | ❌    | ✅  | Partial       | ✅        |
| **Automatic conflict resolution** | ✅        | Basic    | ✅    | ❌  | Paid          | ❌        |
| **Real-time sync**                | ✅        | ✅       | ✅    | ❌  | ❌            | ✅        |
| **Collaborative editing**         | ✅        | ❌       | ✅    | ❌  | ❌            | ❌        |
| **Cursor tracking**               | ✅        | ❌       | ❌    | ❌  | ❌            | ❌        |
| **Editor agnostic**               | ✅        | ❌       | ❌    | ✅  | ❌            | ✅        |
| **Out-of-band edits**             | ✅        | Limited  | ❌    | ✅  | ❌            | ✅        |
| **No conflict markers**           | ✅        | ✅       | ✅    | ❌  | ❌            | ❌        |
| **Comprehensive tests**           | ✅        | ❌       | ❌    | N/A | ❌            | N/A       |
| **Simple deployment**             | ✅        | ❌       | N/A   | ❌  | ✅            | ❌        |
| **Low infrastructure**            | ✅        | ❌       | N/A   | ✅  | ✅            | ✅        |

---

## VaultLink's Unique Position

VaultLink is the **only** solution that combines:

1. **Fully open source** self-hosted server
2. **Editor agnostic** operation (not locked to Obsidian)
3. **Automatic conflict-free merging** using operational transformation
4. **Real-time collaborative editing** with cursor tracking
5. **Differential synchronization** supporting out-of-band edits
6. **Comprehensive test coverage** ensuring reliability
7. **Simple deployment** via Docker or single binary

## Use Case Recommendations

### Choose VaultLink when you:

- Edit vaults with multiple editors (Obsidian + Vim + VS Code)
- Need real-time collaboration with teammates
- Want automatic conflict resolution without manual intervention
- Value full control over infrastructure
- Need production-ready reliability with comprehensive testing
- Want to edit files while offline and sync later seamlessly

### Consider alternatives when you:

- **LiveSync**: Need end-to-end encryption and only use Obsidian
- **Git**: Need full version control with branches and advanced Git features
- **Remotely Save**: Already committed to cloud storage providers
- **Syncthing**: Already use Syncthing and don't need automatic merging

## Migration from Other Solutions

VaultLink works with plain Markdown files, making migration simple:

1. **From Git**: Clone your repo, point VaultLink to the directory
2. **From cloud sync**: Download files, configure VaultLink client
3. **From LiveSync**: Export vault, import to VaultLink
4. **From Syncthing**: Point VaultLink to synced directory

All solutions work with the same Markdown files—VaultLink just syncs them better.

## Beyond Obsidian

Because VaultLink is editor-agnostic, you can use it for:

- **Documentation teams**: Sync technical docs edited in VS Code
- **Academic writing**: Collaborate on papers with various Markdown editors
- **Personal knowledge bases**: Use Obsidian on mobile, Vim on servers
- **Automated workflows**: CLI client for backup systems and CI/CD
- **Multi-tool workflows**: Different team members use different editors

VaultLink doesn't lock you into Obsidian—it's a general-purpose differential sync system that happens to work excellently with Obsidian vaults.

## Next Steps

Ready to try VaultLink?

- [Get started →](/guide/getting-started)
- [Understand the architecture →](/architecture/)
- [See how sync works →](/architecture/sync-algorithm)
