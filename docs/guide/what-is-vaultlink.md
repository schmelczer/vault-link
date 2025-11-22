# What is VaultLink?

Self-hosted sync for Obsidian vaults with automatic conflict-free merging. Edit with any tool, collaborate in real-time, no conflict markers.

## The Problem

Syncing Obsidian vaults across devices or sharing with teammates sucks:

- **Commercial services**: Lock-in, subscriptions, third-party access to your data
- **Git**: Manual conflict resolution with `<<<<<<<` markers interrupting your workflow
- **Cloud storage**: Last-write-wins data loss or manual conflict resolution
- **CRDT solutions**: Only work if you edit inside Obsidian (break if you use Vim, VS Code, etc.)

## VaultLink's Solution

Differential synchronization with operational transformation.

Edit files with Obsidian, Vim, VS Code, or any editor. VaultLink compares versions and automatically merges all changes. No operation tracking required, no conflict markers, no data loss.

## How It Works

1. **Server**: Rust WebSocket server with SQLite stores document versions
2. **Clients**: Obsidian plugin or CLI client watches filesystem changes
3. **Sync**: Changes upload to server, server broadcasts to other clients
4. **Merge**: [reconcile-text](https://schmelczer.dev/reconcile) automatically merges concurrent edits

No CRDT infrastructure. No operation logs. Just file comparison and smart merging.

## Key Advantages

**Editor agnostic**: Edit files with any tool. Other solutions break when you edit outside their ecosystem.

**Self-hosted**: Your data, your server. No third parties, no subscriptions, no surprises.

**Automatic merging**: Operational transformation handles conflicts without interrupting your workflow.

**Production-ready**: Comprehensive tests, E2E tests, battle-tested. Many alternatives have zero tests.

**Collaborative**: Real-time sync with cursor tracking. See where teammates are editing.

## Not Tied to Obsidian

VaultLink syncs Markdown files. Use it for:

- Obsidian vaults (Obsidian desktop + mobile + CLI)
- Technical documentation (VS Code, your-editor, CLI)
- Academic writing (multiple Markdown editors)
- Automated workflows (CLI client for backups/CI/CD)

The Obsidian plugin is just a convenience wrapper around the sync client.

## Quick Comparison

| Feature             | VaultLink | Git | Cloud Sync | CRDT Solutions |
| ------------------- | --------- | --- | ---------- | -------------- |
| Self-hosted         | ✅        | ✅  | ❌         | Varies         |
| Any editor          | ✅        | ✅  | ✅         | ❌             |
| No conflict markers | ✅        | ❌  | ❌         | ✅             |
| Real-time           | ✅        | ❌  | ❌         | ✅             |
| No subscriptions    | ✅        | ✅  | ❌         | Varies         |
| Comprehensive tests | ✅        | N/A | N/A        | ❌             |

[Detailed comparison with alternatives →](/guide/alternatives)

## Next Steps

- [Get started →](/guide/getting-started) (5 minute setup)
- [See the architecture →](/architecture/) (understand how it works)
- [Compare alternatives →](/guide/alternatives) (why VaultLink vs others)
