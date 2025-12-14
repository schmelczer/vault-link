#!/usr/bin/env bash

set -e

node_version=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$node_version" != "22" ]; then
    echo "Error: This script requires Node.js version 22, found: $node_version"
    exit 1
fi
