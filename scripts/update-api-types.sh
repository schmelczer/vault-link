#!/bin/bash

set -e

rm -rf sync-server/bindings

cd sync-server
cargo test export_bindings
cd -

# Both target directories contain only generated bindings — wipe and copy
rm -f frontend/sync-client/src/services/types/*.ts
rm -f frontend/history-ui/src/lib/types/*.ts
cp -r sync-server/bindings/* frontend/sync-client/src/services/types/
cp -r sync-server/bindings/* frontend/history-ui/src/lib/types/

cd frontend
npm run lint
cd ..

# Format all files across the project (frontend and backend)
npx -C frontend prettier --write "**/*.{ts,js,json,md,yml,yaml}"
