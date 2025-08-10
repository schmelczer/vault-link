#!/bin/bash

set -e

rm -rf sync-server/bindings

cd sync-server
cargo test export_bindings
cd -

cp -r sync-server/bindings/* frontend/sync-client/src/services/types/

cd frontend
npm run lint || npx prettier --write sync-client/src/services/types/*.ts
cd -
