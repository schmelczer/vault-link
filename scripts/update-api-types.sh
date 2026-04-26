#!/bin/bash

set -e

rm -rf sync-server/bindings

cd sync-server
cargo test export_bindings
cd -

# sync-client/src/services/types contains only generated bindings — wipe and copy
rm -f frontend/sync-client/src/services/types/*.ts
cp -r sync-server/bindings/* frontend/sync-client/src/services/types/

# history-ui/src/lib/types contains generated bindings plus a hand-written index.ts
find frontend/history-ui/src/lib/types -maxdepth 1 -name "*.ts" ! -name "index.ts" -delete
cp -r sync-server/bindings/* frontend/history-ui/src/lib/types/

cd frontend
npm run lint
cd ..

# Format all files across the project (frontend and backend)
npx -C frontend prettier --write "**/*.{ts,js,json,md,yml,yaml}"
