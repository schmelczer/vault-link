#!/usr/bin/env bash

set -e

FIX_MODE=false
if [[ "$1" == "--fix" ]]; then
    FIX_MODE=true
    echo "Running in fix mode - will automatically fix linting and formatting issues"
fi

./scripts/utils/check-node.sh

echo "Running checks in sync-server"

cd sync-server
which sqlx || cargo install sqlx-cli
sqlx database create --database-url sqlite://db.sqlite3
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3

cargo test --verbose

if [[ "$FIX_MODE" == true ]]; then
    cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged
    cargo fmt --all
else
    cargo clippy --all-targets --all-features
    cargo fmt --all -- --check
fi

which cargo-machete || cargo install cargo-machete
cargo machete --with-metadata

echo "Running checks in frontend"
cd ../frontend

if [[ "$FIX_MODE" == true ]]; then
    npm install
else
    npm ci
fi

cd ..

cd frontend
npm run build
npm run test
npm run lint

# Use git ls-files to only check tracked files, respecting .gitignore
# We always run in fix mode and then check with git status
git ls-files | xargs npx eclint fix

if [[ "$FIX_MODE" == false ]] && [[ $(git status --porcelain) ]]; then
    git status --porcelain
    echo "Failing CI because the working directory is not clean after linting"
    exit 1
fi

cd ..

echo "Success"
