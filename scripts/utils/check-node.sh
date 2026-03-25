#!/usr/bin/env bash

set -e

TARGET_NODE_VERSION=25

node_version=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$node_version" != "$TARGET_NODE_VERSION" ]; then
    echo "Error: This script requires Node.js version $TARGET_NODE_VERSION, found: $node_version"
    exit 1
fi
