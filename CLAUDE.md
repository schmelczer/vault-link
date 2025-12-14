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

### Initial Setup

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
cd frontend
npm install
```

### Server Development

```bash
cd sync-server
cargo run config-e2e.yml  # Start development server
cargo test --verbose      # Run all Rust tests
cargo test <test_name>    # Run specific test
cargo clippy --all-targets --all-features  # Lint Rust code
cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged  # Auto-fix clippy warnings
cargo fmt --all -- --check  # Check Rust formatting
cargo fmt --all            # Auto-format Rust code
cargo machete --with-metadata  # Detect unused dependencies
```

### Frontend Development

```bash
cd frontend
npm run dev      # Start development mode (watches sync-client and obsidian-plugin)
npm run build    # Build all workspaces
npm run build -w sync-client     # Build specific workspace
npm run test     # Run all tests across all workspaces
npm run test -w sync-client      # Run tests for specific workspace
npm run lint     # Lint and format TypeScript code with ESLint + Prettier
```

### Database Operations

```bash
cd sync-server
# Create/reset database for development
rm -rf db.sqlite*
sqlx database create --database-url sqlite://db.sqlite3
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
cargo sqlx prepare --workspace

# Add new migration
sqlx migrate add --source src/app_state/database/migrations <migration_name>
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
```

### Project Scripts

- `scripts/check.sh`: Full CI check (builds, lints, tests both server and frontend). **Run before pushing.**
- `scripts/check.sh --fix`: Same as above but auto-fixes linting and formatting issues
- `scripts/e2e.sh`: End-to-end testing (e.g., `scripts/e2e.sh 8` for 8 concurrent clients)
- `scripts/clean-up.sh`: Clean logs and database files
- `scripts/bump-version.sh patch`: Publish new version (options: patch, minor, major)
- `scripts/update-api-types.sh`: Update TypeScript bindings from Rust types (uses ts-rs)

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
2. Run `scripts/update-api-types.sh` to copy bindings to `frontend/sync-client/src/services/types/`
3. Frontend imports these types for type-safe API communication

### Important Implementation Details

**SQLx Compile-Time Verification:**

- SQLx verifies SQL queries at compile time against the database schema
- Run `cargo sqlx prepare --workspace` after schema changes to update `.sqlx/` directory
- CI builds require prepared query metadata to avoid needing a live database

## Testing

### Running Tests

**Server:**

```bash
cargo test --verbose           # All tests
cargo test <test_name>         # Specific test
```

**Frontend:**

```bash
npm run test                   # All workspaces
npm run test -w sync-client    # Specific workspace
```

**E2E:**

```bash
scripts/e2e.sh 8               # 8 concurrent clients
scripts/clean-up.sh            # Clean up after tests
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
