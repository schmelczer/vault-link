# What is VaultLink?

VaultLink is a self-hosted real-time synchronization system for Obsidian vaults. It provides collaborative file syncing with automatic conflict resolution, designed for users who want complete control over their data.

## Overview

VaultLink consists of three main components:

### Sync Server

A Rust-based WebSocket server that handles:
- Real-time bidirectional synchronization
- Document versioning with SQLite
- User authentication and vault access control
- Operational transformation for conflict resolution

### Obsidian Plugin

A native Obsidian plugin that:
- Integrates sync directly into your Obsidian workflow
- Provides real-time updates as you edit
- Handles file watching and automatic synchronization
- Works across desktop and mobile platforms

### CLI Client

A standalone synchronization client that:
- Syncs vaults without requiring Obsidian
- Perfect for servers, automation, or backup systems
- Provides file watching and bidirectional sync
- Runs in Docker or as a standalone binary

## Key Features

### Real-Time Synchronization

Changes are synchronized immediately via WebSocket connections. When multiple users edit the same file, operational transformation ensures all edits are preserved without conflicts.

### Self-Hosted Architecture

Run the sync server on your own infrastructure:
- Full control over data storage and access
- No dependency on third-party services
- Configurable authentication and authorization
- Deploy anywhere: cloud VPS, home server, or localhost

### Operational Transformation

VaultLink uses the `reconcile-text` library for intelligent conflict resolution:
- Simultaneous edits are automatically merged
- No manual conflict resolution required
- Preserves intent of all contributors
- Works seamlessly in the background

### Flexible Authentication

Configure user access per vault:
- Token-based authentication
- Per-user vault access control
- Allow-list or deny-list patterns
- Support for multiple users and vaults

## Use Cases

### Personal Sync

Synchronize your Obsidian vault across multiple devices:
- Laptop, desktop, and mobile in real-time
- No cloud service subscription required
- Full privacy and data control

### Team Collaboration

Share knowledge bases with teammates:
- Real-time collaborative editing
- Granular access control per vault
- Self-hosted for enterprise security requirements

### Automated Backups

Use the CLI client for automated workflows:
- Scheduled backups to remote servers
- Integration with existing backup systems
- Headless operation without Obsidian

### Development & Testing

Synchronize documentation across environments:
- Keep docs in sync with development environments
- Automated deployment of documentation
- Version control integration

## How It Works

1. **Server Setup**: Deploy the sync server on your infrastructure
2. **Authentication**: Configure users and vault access in `config.yml`
3. **Client Connection**: Connect via Obsidian plugin or CLI client
4. **Initial Sync**: Client uploads local files to server
5. **Real-Time Updates**: Changes sync bidirectionally via WebSocket
6. **Conflict Resolution**: Operational transformation handles simultaneous edits

## Technology Stack

- **Server**: Rust with Axum framework, SQLite database, WebSocket protocol
- **Frontend**: TypeScript with WebSocket client, npm workspaces
- **Sync Algorithm**: reconcile-text operational transformation library
- **Deployment**: Docker images, binary releases, or source builds

## Next Steps

Ready to get started?

- [Getting Started Guide →](/guide/getting-started)
- [Server Setup →](/guide/server-setup)
- [Architecture Overview →](/architecture/)
