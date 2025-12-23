---
layout: home

hero:
    name: VaultLink
    text: Self-Hosted Sync & Collaboration for Obsidian and beyond
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
    - title: Single-binary server meant for self-hosting
      details: Simple Rust-powered WebSocket server with SQLite.

    - title: Your Data, Your Server
      details: Built with self-hosting in mind. Single simple Docker container or binary.

    - title: Real-Time Collaboration
      details: See your collaborators' cursors and edits instantly. Or just use it to sync your files across devices.

    - title: Obsidian plugin
      details: First-class support for Obsidian through the [VaultLink]() plugin. Sync changes coming from both within and outside of your Obsidian Vault.

    - title: Interoperability is the new default
      details: VaultLink isn't limited to Obsidian. It comes with a client CLI, and can be easily embedded into other editors and knowledgebases as a plugin to unlock true interoperability.
      
    - title: No Conflict Markers
      details: Never see conflict markers in your notes again. Automatic smart merging for text without human intervention which never drops changes. See the [reconcile demo](https://schmelczer.dev/reconcile) for an intuitive visualisation.

    - title: Open Source Everything
      details: MIT licensed. Server, clients, and sync algorithm are all open source. No proprietary components.
---

## What is VaultLink?

VaultLink is an editor agnostic sync & collaboration engine consisting of:
- a self-hostable server
- an [Obsidian](https://obsidian.md) plugin
- and an optional plugin library & CLI client for integrating with other editors

I'm deeply concived that the shape of a personal knwoledgebase, stack of notes, or "operating system for life" is a folder of Markdown files and attachments. I believe in a rich editing experience built on top of plain text files, owning your own data, and eliminating moats between propriety products.

Obsidian is a well-loved editor ([see the 2025 self-hosting survey]()). Even though it supports E2EE Syncing, it's done through a propriety plugin limited to Obsidian which also lacks support for collaboration. Existing 3rd-party syncing solutions fall short of delivering a stable and editor-agnostic experience. For more on this, see the [alternatives](/guide/alternatives).

VaultLink finally delivers a reliable, self-hosted, and editor-agnostic syncing solution with first-class support for Obsidian.
> And more editors to come in the future, see the [roadmap]().


## Quick Start

Deploy server (single command):

```bash
docker run -d -p 3000:3000 -v $(pwd)/data:/data \
  ghcr.io/schmelczer/vault-link-server:latest
```

Then install the [Obsidian plugin](/guide/obsidian-plugin) or [CLI client](/guide/cli-client).

[Full setup guide →](/guide/getting-started)

## What makes VaultLink special

VaultLink's architecture enables a few unique features:
- Its text merging algorithm handles conflicting (even offline & coming from outside the editor) edits without human oversights while ensuring no changes are dropped. Learn more about this in the [syncing algorithm section](architecture/sync-algorithm.md).
- Provides its full feature set through shallow integration meaning that it's straightforward to integrate into editors even ones which haven't been written with real-time collaboration and remote backups in mind. This is detailed in the [architecture section](architecture/index.md).
- There are various text editor/wiki/knowledgebase style apps & websites around. Users should be able to mix & match between them, try them out, and collaborate with people preferring a different editor than themselves. The long-term goal of VaultLink is to break down these barriers. As of today, the two clients are a CLI exectuable client and an Obsidian plugin. However, there's more to come. So for an overview, head to the [roadmap](roadmap.md) page.  
