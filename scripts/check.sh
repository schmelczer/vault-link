#!/usr/bin/env bash

set -e

echo "Running checks in sync-server"
cd sync-server
cargo test --verbose
cargo clippy --all-targets --all-features
cargo fmt --all -- --check
cargo machete

echo "Running checks in frontend"
cd ../frontend
npm ci
npm run build
npm run test
npm run lint

if [[ $(git status --porcelain) ]]; then
    git status --porcelain
    echo "Failing CI because the working directory is not clean after linting"
    exit 1
fi

echo "Success"

cd ..
