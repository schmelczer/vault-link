---
layout: home

hero:
  name: VaultLink
  text: Self-Hosted Sync for Obsidian
  tagline: Real-time collaborative file synchronization for your knowledge base
  image:
    src: /logo.svg
    alt: VaultLink
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/schmelczer/vault-link

features:
  - icon: 🚀
    title: Real-Time Synchronization
    details: Operational transformation-based conflict resolution ensures your files stay in sync across devices without data loss
  - icon: 🔒
    title: Self-Hosted & Private
    details: Run your own sync server. Your data stays on your infrastructure with full control over access and privacy
  - icon: 🎯
    title: Obsidian Plugin
    details: Native integration with Obsidian for seamless synchronization directly within your favorite note-taking app
  - icon: 🖥️
    title: CLI Client
    details: Sync vaults to any system using the standalone CLI client. Perfect for servers, automation, or headless setups
  - icon: ⚡
    title: Built for Performance
    details: Rust-powered WebSocket server with SQLite backend delivers blazing-fast sync performance
  - icon: 🛠️
    title: Flexible Deployment
    details: Deploy via Docker, binary releases, or build from source. Configure authentication and access controls to fit your needs
---

## Quick Start

Deploy the sync server:

```bash
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/data:/data \
  ghcr.io/schmelczer/vault-link-server:latest \
  /app/sync_server config.yml
```

Install the Obsidian plugin or use the CLI client:

```bash
docker run -v /path/to/vault:/vault \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault -r wss://your-server.com -t your-token -v default
```

[Learn more →](/guide/getting-started)

## Why VaultLink?

VaultLink provides a complete self-hosted synchronization solution for Obsidian:

- **No third-party services**: Your data never leaves your infrastructure
- **Operational transformation**: Smart conflict resolution that preserves all changes
- **Multi-platform**: Works with Obsidian plugin or standalone CLI on any system
- **Production-ready**: Docker images, health checks, and comprehensive logging
- **Open source**: MIT licensed with active development

[Read the architecture overview →](/architecture/)
