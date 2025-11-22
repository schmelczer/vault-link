---
layout: home

hero:
    name: VaultLink
    text: Self-Hosted Obsidian Sync
    tagline: Edit with any tool. Automatic conflict-free merging. Your infrastructure.
    image:
        src: /logo.svg
        alt: VaultLink
    actions:
        - theme: brand
          text: Get Started
          link: /guide/getting-started
        - theme: alt
          text: Why VaultLink?
          link: /guide/what-is-vaultlink

features:
    - title: Edit Anywhere
      details: Use Obsidian, Vim, VS Code, or any editor. VaultLink syncs files, not keystrokes—edit however you want
    - title: Your Data, Your Server
      details: Fully self-hosted. No third parties, no subscriptions, no data mining. Single Docker container or binary
    - title: No Conflict Markers
      details: Automatic merge using operational transformation. Never see conflict markers in your notes again
    - title: Real-Time Collaboration
      details: See teammate cursors, merge edits instantly. Rust-powered WebSocket server with SQLite
    - title: Open Source Everything
      details: MIT licensed. Server, clients, and sync algorithm are all open source. No proprietary components
    - title: Battle-Tested
      details: Comprehensive test suite. E2E tests. Used in production. Unlike alternatives with zero tests
---

## Why Self-Host?

**You own your knowledge base.** Commercial sync services can disappear, change pricing, or lock you out. VaultLink runs on your infrastructure—VPS, home server, or localhost.

**Edit with any tool.** Other solutions require CRDT-aware editors or break when you edit outside Obsidian. VaultLink uses differential sync: edit files however you want, sync handles the rest.

**No conflict markers.** Git forces manual merging. Other tools use last-write-wins. VaultLink's operational transformation automatically merges Markdown and text files without conflict markers or workflow interruption. [See what's supported →](/guide/limitations)

[See how VaultLink compares to alternatives →](/guide/alternatives)

## Quick Start

Deploy server (single command):

```bash
docker run -d -p 3000:3000 -v $(pwd)/data:/data \
  ghcr.io/schmelczer/vault-link-server:latest
```

Then install the [Obsidian plugin](/guide/obsidian-plugin) or [CLI client](/guide/cli-client).

[Full setup guide →](/guide/getting-started)
