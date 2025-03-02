#!/bin/bash

set -e

npm run build

pids=()
for i in {1..10}; do
    node dist/cli.js 2>&1 | tee "log_${i}.log" &
    pids+=($!)
done

trap 'kill ${pids[@]} 2>/dev/null' SIGINT SIGTERM

for pid in ${pids[@]}; do
    if ! wait $pid; then
        kill ${pids[@]} 2>/dev/null
        echo "Process $pid failed, see log_$(echo ${pids[@]} | tr ' ' '\n' | grep -n "^$pid$" | cut -d: -f1).log"
        exit 1
    fi
done
