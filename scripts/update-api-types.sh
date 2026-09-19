#!/bin/bash

set -e

# This directory contains only generated bindings. ts-rs writes here directly,
# as configured in .cargo/config.toml.
rm -f frontend/sync-client/src/services/types/*.ts

(
    cd sync-server
    cargo test export_bindings
)

(
    cd frontend
    npm run lint
)

# Format all files across the project (frontend and backend)
npx -C frontend prettier --write "**/*.{ts,js,json,md,yml,yaml}"
