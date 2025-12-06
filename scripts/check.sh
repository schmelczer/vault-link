#!/usr/bin/env bash

set -e

# Parse arguments
FIX_MODE=false
if [[ "$1" == "--fix" ]]; then
    FIX_MODE=true
    echo "Running in fix mode - will automatically fix linting and formatting issues"
fi

echo "Running checks in sync-server"
cd sync-server
cargo test --verbose

if [[ "$FIX_MODE" == true ]]; then
    cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged
    cargo fmt --all
else
    cargo clippy --all-targets --all-features
    cargo fmt --all -- --check
fi

cargo install cargo-machete
cargo machete --with-metadata

echo "Running checks in frontend"
cd ../frontend

if [[ "$FIX_MODE" == true ]]; then
    npm install
else
    npm ci
fi
npm run build
npm run test
npm run lint

if [[ "$FIX_MODE" == false ]] && [[ $(git status --porcelain) ]]; then
    git status --porcelain
    echo "Failing CI because the working directory is not clean after linting"
    exit 1
fi

cd ..

if [[ "$FIX_MODE" == true ]]; then
    $0
else
    echo "Success"
fi
