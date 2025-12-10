#!/usr/bin/env bash

set -e

cd docs

npm ci
npm run format:check
npm run spell:check
npm run build

cd -
