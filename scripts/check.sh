#!/usr/bin/env bash

set -e

echo "Running checks in sync-server"
cd sync-server
cargo clippy --all-targets --all-features
cargo fmt --all -- --check
cargo machete
cargo test --verbose


echo "Running checks in frontend"
cd ../frontend
npm ci
npm run build
npm run lint
if [[ $(git status --porcelain) ]]; then
    git status --porcelain
    echo "Failing CI because the working directory is not clean after linting"
    exit 1
fi
npm run test

echo "Finished"

cd ..
