# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VaultLink is a self-hosted Obsidian plugin for real-time collaborative file syncing. The project consists of a Rust-based sync server and a TypeScript frontend with three main components: an Obsidian plugin, a sync client library, and a test client.

## Architecture

### Core Components

- **sync-server/**: Rust-based WebSocket server with SQLite database for document versioning and real-time synchronization
- **frontend/sync-client/**: TypeScript library providing core sync functionality, WebSocket management, and file operations
- **frontend/obsidian-plugin/**: Obsidian plugin that integrates the sync client with Obsidian's API
- **frontend/test-client/**: CLI testing tool for the sync functionality

### Key Technologies

- **Backend**: Rust with Axum framework, SQLite with SQLx, WebSockets for real-time sync
- **Frontend**: TypeScript, Webpack for bundling, Jest for testing
- **Sync Algorithm**: Uses reconcile-text library for operational transformation

## Development Commands

### Server Development
```bash
cd sync-server
cargo run config-e2e.yml  # Start development server
cargo test --verbose      # Run Rust tests
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
npm run test     # Run all tests
npm run lint     # Lint and format TypeScript code
```

### Database Setup (Development)
```bash
cd sync-server
sqlx database create --database-url sqlite://db.sqlite3
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
cargo sqlx prepare --workspace
```

### Initial Setup
```bash
# Install required cargo tools
cargo install sqlx-cli cargo-machete cargo-edit
```

### Scripts
- `scripts/check.sh`: Full CI check (builds, lints, tests both server and frontend)
- `scripts/check.sh --fix`: Same as above but auto-fixes linting and formatting issues
- `scripts/e2e.sh`: End-to-end testing
- `scripts/clean-up.sh`: Clean logs and database files
- `scripts/bump-version.sh patch`: Publish new version
- `scripts/update-api-types.sh`: Update TypeScript bindings from Rust types

## Code Structure

### Workspace Configuration
The frontend uses npm workspaces with four packages:
- `sync-client`: Core synchronization logic
- `obsidian-plugin`: Obsidian-specific integration
- `test-client`: Testing utilities
- `local-client-cli`: Standalone CLI for VaultLink sync client

### Type Generation
Rust structs generate TypeScript types via ts-rs crate, stored in `sync-server/bindings/` and used by frontend packages.

### Key Files
- `sync-server/src/`: Rust server implementation with WebSocket handlers
- `frontend/sync-client/src/sync-client.ts`: Main sync client entry point
- `frontend/obsidian-plugin/src/vault-link-plugin.ts`: Main Obsidian plugin class
- `frontend/sync-client/src/services/sync-service.ts`: Core synchronization logic

## Testing

### Running Tests
- Server: `cargo test --verbose` 
- Frontend: `npm run test` (runs Jest across all workspaces)
- E2E: `scripts/e2e.sh`

### Test Structure
- Rust: Unit tests alongside source files
- TypeScript: `.test.ts` files using Jest
- E2E: Uses test-client to simulate multiple concurrent users

## Code Style

### Rust
- Uses extensive Clippy lints (see Cargo.toml)
- Follows pedantic linting rules
- Forbids unsafe code
- Uses cargo fmt with default settings

### TypeScript
- Prettier configuration: 4-space tabs, trailing commas removed, LF line endings
- ESLint with unused imports plugin
- Consistent across all three frontend packages