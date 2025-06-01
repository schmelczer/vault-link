#!/bin/bash

set -e

./scripts/utils/wait-for-server.sh

rm -rf backend/sync_server/bindings
cd backend
cargo test export_bindings
cd -

cp -r backend/sync_server/bindings/* frontend/sync-client/src/services/types/

npm install -g openapi-typescript
openapi-typescript http://localhost:3000/api.json --output frontend/sync-client/src/services/types/http-api.ts
