#!/usr/bin/env bash

set -e

./scripts/utils/check-node.sh

(
    cd docs

    npm ci
    npm run format:check
    npm run spell:check
    npm run build
)
