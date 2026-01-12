# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VaultLink is a self-hosted Obsidian plugin for real-time collaborative file syncing. The project consists of a Rust-based sync server and a TypeScript frontend with four main components: an Obsidian plugin, a sync client library, a test client, and a standalone CLI client.

## Architecture

### Core Components

- **sync-server/**: Rust-based WebSocket server with SQLite database for document versioning and real-time synchronization
- **frontend/sync-client/**: TypeScript library providing core sync functionality, WebSocket management, and file operations
- **frontend/obsidian-plugin/**: Obsidian plugin that integrates the sync client with Obsidian's API
- **frontend/test-client/**: CLI testing tool for simulating multiple concurrent users
- **frontend/local-client-cli/**: Standalone CLI for VaultLink sync client

### Key Technologies

- **Backend**: Rust with Axum framework, SQLite with SQLx, WebSockets for real-time sync
- **Frontend**: TypeScript, Webpack for bundling, Node.js native test runner
- **Sync Algorithm**: Uses reconcile-text library for operational transformation

### Architectural Patterns

**Server Architecture:**

- `AppState`: Central state container holding `Database`, `Cursors`, and `Broadcasts`
- `Database`: SQLite-backed document versioning with SQLx for compile-time query verification
- `Broadcasts`: WebSocket broadcast system for real-time updates to connected clients
- `Cursors`: Tracks user cursor positions across documents with background cleanup task

**Client Architecture:**

- `SyncClient`: Main entry point, orchestrates all sync operations
- `SyncService`: HTTP API client for CRUD operations on documents
- `WebSocketManager`: Manages WebSocket connection and real-time updates
- `Syncer`: Coordinates file synchronization between local filesystem and server
- `CursorTracker`: Manages local and remote cursor positions
- `Database`: Client-side document metadata cache
- `FileOperations`: Abstraction layer for filesystem operations

**Dual-Bundle Strategy:**
The sync-client builds two separate bundles:

- `sync-client.web.js`: Browser-compatible UMD bundle (excludes `ws` package)
- `sync-client.node.js`: Node.js CommonJS bundle with WebSocket support

## Development Commands

This project uses [Taskfile](https://taskfile.dev/) for task automation. Run `task --list` to see all available tasks.

### Initial Setup

**Taskfile:**

```bash
# Install Task (https://taskfile.dev/installation/)
# macOS
brew install go-task

# Linux
sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b ~/.local/bin

# Or via npm
npm install -g @go-task/cli
```

**Node.js (requires version 25):**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 25
nvm use 25
nvm alias default 25  # Optional: set as system default
```

**Rust:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
cargo install sqlx-cli cargo-machete cargo-edit cargo-insta
```

**Frontend:**

```bash
task frontend:install
```

### Common Tasks (Taskfile)

```bash
task check           # Full CI check (lint, test, format). Run before pushing.
task check:fix       # Same as above but auto-fixes issues
task e2e -- 8        # E2E tests with 8 concurrent clients
task clean           # Clean logs and database files
task update-api-types  # Update TypeScript bindings from Rust types
task release:bump -- patch  # Bump version (patch|minor|major)
```

### Server Tasks

```bash
task rust:run        # Start development server
task rust:test       # Run all Rust tests
task rust:clippy     # Lint Rust code
task rust:clippy-fix # Auto-fix clippy warnings
task rust:fmt        # Format Rust code
task rust:fmt-check  # Check Rust formatting
task rust:machete    # Detect unused dependencies
```

### Frontend Tasks

```bash
task frontend:dev    # Start development mode
task frontend:build  # Build all workspaces
task frontend:test   # Run all frontend tests
task frontend:lint   # Lint and format TypeScript
```

### Database Tasks

```bash
task db:setup        # Create and migrate database
task db:reset        # Reset database (delete and recreate)
task db:prepare      # Prepare SQLx offline data
task db:add-migration NAME=<migration_name>  # Add new migration
```

### Documentation Tasks

```bash
task docs:check      # Build and check documentation
task docs:dev        # Start documentation dev server
```

### Direct Commands (Alternative)

If you prefer not to use Taskfile, these commands work directly:

**Server:**

```bash
cd sync-server
cargo run config-e2e.yml  # Start development server
cargo test --verbose      # Run all Rust tests
cargo clippy --all-targets --all-features  # Lint
cargo fmt --all           # Format
```

**Frontend:**

```bash
cd frontend
npm run dev      # Development mode
npm run build    # Build all workspaces
npm run test     # Run tests
npm run lint     # Lint and format
```

**Database:**

```bash
cd sync-server
sqlx database create --database-url sqlite://db.sqlite3
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
```

## Code Structure

### Workspace Configuration

The frontend uses npm workspaces with four packages:

- `sync-client`: Core synchronization logic (builds dual bundles for web and Node.js)
- `obsidian-plugin`: Obsidian-specific integration
- `test-client`: Testing utilities for E2E tests
- `local-client-cli`: Standalone CLI for VaultLink sync client

### Type Generation and API Updates

Rust structs generate TypeScript types via ts-rs crate:

1. Rust structs annotated with `#[derive(TS)]` export to `sync-server/bindings/`
2. Run `task update-api-types` to copy bindings to `frontend/sync-client/src/services/types/`
3. Frontend imports these types for type-safe API communication

### Important Implementation Details

**SQLx Compile-Time Verification:**

- SQLx verifies SQL queries at compile time against the database schema
- Run `cargo sqlx prepare --workspace` after schema changes to update `.sqlx/` directory
- CI builds require prepared query metadata to avoid needing a live database

## Testing

### Running Tests

```bash
task rust:test         # All Rust tests
task frontend:test     # All frontend tests
task e2e -- 8          # E2E with 8 concurrent clients
task clean             # Clean up after tests
```

Or use direct commands:

```bash
cd sync-server && cargo test --verbose    # Rust tests
cd frontend && npm run test               # Frontend tests
```

### Test Structure

- **Rust**: Unit tests alongside source files, uses `cargo-insta` for snapshot testing
- **TypeScript**: `.test.ts` files using Node.js native test runner (not Jest)
- **E2E**: Uses `test-client` to simulate multiple concurrent users with random operations

## Code Style and Formatting

### Rust

- Extensive Clippy lints (see `Cargo.toml`)
- Pedantic linting rules enabled
- Forbids unsafe code
- Uses `rustfmt.toml` for formatting configuration (4 spaces, Unix line endings)
- Run `cargo fmt --all` to format

### TypeScript

- **Prettier**: 4-space indentation, no trailing commas, LF line endings
- **YAML/Markdown override**: 2-space indentation (via prettier config)
- **ESLint**: Strict rules with unused imports detection
- Configuration in `frontend/package.json`
- Run `npm run lint` to format and fix issues

### EditorConfig

- `.editorconfig` at project root defines baseline formatting rules
- `rustfmt.toml` and Prettier config explicitly mirror these settings
- Both formatters enforce: 4-space indent (2 for YAML/MD), LF endings, final newline, trim trailing whitespace
