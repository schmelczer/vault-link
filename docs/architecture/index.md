# Architecture Overview

Central sync server with multiple clients. High-level architecture and design decisions.

## System Components

```
┌─────────────────────────────────────────────────────────────┐
│                        Clients                              │
├─────────────────────┬───────────────────┬───────────────────┤
│  Obsidian Plugin    │  Obsidian Plugin  │   CLI Client      │
│  (User A - Device1) │  (User A - Device2│   (Server/Backup) │
└──────────┬──────────┴─────────┬─────────┴──────────┬────────┘
           │                    │                    │
           │    WebSocket       │   WebSocket        │   WebSocket
           │                    │                    │
           └────────────────────┼────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   Sync Server         │
                    │   (Rust + Axum)       │
                    │                       │
                    │  ┌─────────────────┐  │
                    │  │  WebSocket Hub  │  │
                    │  └────────┬────────┘  │
                    │           │           │
                    │  ┌────────▼────────┐  │
                    │  │ Sync Engine     │  │
                    │  │ (OT Algorithm)  │  │
                    │  └────────┬────────┘  │
                    │           │           │
                    │  ┌────────▼────────┐  │
                    │  │ SQLite Database │  │
                    │  │ (Per Vault)     │  │
                    │  └─────────────────┘  │
                    └───────────────────────┘
```

## Core Components

### Sync Server

Central authority for synchronisation. Rust + Axum framework.

**Responsibilities**:

- Accept WebSocket connections from clients
- Authenticate users via token-based auth
- Store document versions in SQLite
- Coordinate real-time updates between clients
- Apply operational transformation for conflict resolution
- Manage vault access control

**Technology**:

- **Language**: Rust 1.89+
- **Framework**: Axum (async web framework)
- **Database**: SQLite with SQLx
- **Protocol**: WebSockets for real-time communication
- **Sync Algorithm**: reconcile-text (operational transformation)

### Sync Client Library

TypeScript library with core sync logic. Used by Obsidian plugin and CLI client.

**Responsibilities**:

- Manage WebSocket connection to server
- Watch local filesystem for changes
- Upload and download files
- Apply remote changes locally
- Handle conflict resolution
- Maintain sync metadata

**Technology**:

- **Language**: TypeScript
- **Build**: Webpack
- **Protocol**: WebSocket client
- **File System**: Node.js `fs` API / Obsidian API

### Obsidian Plugin

Integration layer between sync client and Obsidian.

**Responsibilities**:

- Provide UI for configuration
- Bridge sync client with Obsidian's file system API
- Handle Obsidian lifecycle events
- Display sync status to users

**Technology**:

- **Platform**: Obsidian Plugin API
- **Core**: sync-client library
- **UI**: Obsidian settings UI

### CLI Client

Standalone executable for syncing vaults without Obsidian.

**Responsibilities**:

- Command-line interface
- File system access via Node.js
- Daemon mode for continuous sync
- Health check endpoint for monitoring

**Technology**:

- **Language**: TypeScript
- **Runtime**: Node.js
- **CLI**: Commander.js
- **Core**: sync-client library

## Data Flow

### Initial Connection

1. Client connects via WebSocket to server
2. Server authenticates using provided token
3. Server verifies user has access to requested vault
4. Connection established, sync begins

### File Upload Flow

```
Client                          Server
  │                               │
  │  1. File changed locally      │
  │                               │
  │  2. Read file content         │
  │                               │
  │  3. WebSocket: Upload file    │
  ├──────────────────────────────►│
  │                               │ 4. Store in SQLite
  │                               │
  │                               │ 5. Broadcast to other clients
  │                               ├───────────────────────►
  │  6. Ack upload                │
  │◄──────────────────────────────┤
```

### File Download Flow

```
Client A                  Server                  Client B
  │                         │                         │
  │                         │  1. File uploaded       │
  │                         │◄────────────────────────┤
  │                         │                         │
  │                         │ 2. Store in DB          │
  │                         │                         │
  │  3. Push notification   │                         │
  │◄────────────────────────┤                         │
  │                         │                         │
  │  4. Download file       │                         │
  ├────────────────────────►│                         │
  │                         │                         │
  │  5. Write locally       │                         │
  │                         │                         │
```

### Conflict Resolution

When two clients edit the same file simultaneously:

```
Client A                  Server                  Client B
  │                         │                         │
  │ 1. Edit file            │                         │ 1. Edit same file
  │                         │                         │
  │ 2. Upload changes       │                         │ 2. Upload changes
  ├────────────────────────►│◄────────────────────────┤
  │                         │                         │
  │                         │ 3. Apply OT algorithm   │
  │                         │    - Merge both edits   │
  │                         │    - Preserve all changes│
  │                         │                         │
  │ 4. Receive merged ver.  │ 5. Receive merged ver.  │
  │◄────────────────────────┤────────────────────────►│
  │                         │                         │
  │ 6. Apply locally        │                         │ 6. Apply locally
```

## Storage Architecture

### Server Storage

Each vault has its own SQLite database:

```
databases/
├── vault-1.db
├── vault-2.db
└── shared-team.db
```

**Database Schema** (simplified):

- **documents**: File metadata (path, size, modified time)
- **versions**: Document content with version history
- **cursors**: Client sync state

### Client Storage

Clients maintain sync metadata:

```
.vaultlink/
├── metadata.json       # Sync state
└── cache/              # Optional local cache
```

The `.vaultlink` directory tracks which files have been synced and their versions to enable efficient synchronisation.

## Communication Protocol

### WebSocket Messages

Client-server communication uses JSON messages over WebSocket.

**Message Types**:

- `upload_file`: Client → Server (file upload)
- `download_file`: Client → Server (request file)
- `file_updated`: Server → Client (file changed notification)
- `file_deleted`: Server → Client (file deleted notification)
- `sync_complete`: Server → Client (initial sync finished)

### Authentication

Token-based authentication on connection:

```typescript
// Client sends token on connect
{
  type: "auth",
  token: "user-auth-token",
  vault: "vault-name"
}

// Server responds
{
  type: "auth_success"
}
// or
{
  type: "auth_error",
  message: "Invalid token"
}
```

## Scalability Considerations

### Current Architecture

- **SQLite per vault**: Simple, performant, limited to single server
- **WebSocket connections**: Stateful, requires sticky sessions for load balancing
- **Operational transformation**: Centralized on server

### Scaling Approaches

**Vertical Scaling**:

- Increase server resources (CPU, RAM, storage)
- Optimize database queries and indexing
- Tune connection limits

**Horizontal Scaling** (future):

- Separate vault servers (vault sharding)
- Load balancer with sticky sessions
- Shared storage layer for SQLite databases
- Consider alternative databases (PostgreSQL) for multi-server setups

### Performance Characteristics

- **Small vaults** (< 1000 files): Excellent performance
- **Medium vaults** (1000-10000 files): Good performance with tuning
- **Large vaults** (> 10000 files): May require optimisation
- **Concurrent users**: Tested with dozens of simultaneous clients per vault

## Security Model

### Authentication

- Token-based authentication
- Tokens configured in server `config.yml`
- No password hashing (tokens are secrets)

### Authorization

- Per-user vault access control
- Allow-list or deny-list patterns
- Global access or vault-specific access

### Network Security

- WebSocket over TLS (WSS) for encrypted transport
- No built-in SSL (use reverse proxy)
- CORS configured for web clients

### Data Security

- No encryption at rest (use encrypted filesystems if needed)
- No end-to-end encryption (server sees all content)
- Self-hosted model: you control the data

## Technology Choices

**Rust**: Low latency, memory safe, excellent async with Tokio, compile-time SQL verification

**SQLite**: No separate database server, fast for reads, single file per vault, backups are file copies

**WebSocket**: Bidirectional push, no polling overhead, built-in browser/Node.js support

**Operational Transformation**: Automatic conflict resolution, preserves all edits, real-time collaboration

## Design Principles

1. **Self-hosted first**: Users control their data and infrastructure
2. **Simplicity**: Easy to deploy and operate
3. **Real-time**: Changes appear immediately
4. **Reliability**: Handle network failures gracefully
5. **Performance**: Fast sync for typical vault sizes
6. **Privacy**: No third-party services or telemetry

## Next Steps

- [Learn about the sync algorithm →](/architecture/sync-algorithm)
- [Understand data flow in detail →](/architecture/data-flow)
- [Deploy the server →](/guide/server-setup)
