#!/bin/bash

set -e
set -o pipefail

NO_COLOR=1
FORCE_COLOR=0

node_version=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$node_version" != "22" ]; then
    echo "Error: This script requires Node.js version 22, found: $node_version"
    exit 1
fi

# Check if the argument is provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <number_of_processes>"
    exit 1
fi

# Get the number of processes from the first argument
process_count=$1

mkdir -p logs

cd frontend
npm ci
npm run build

../scripts/utils/wait-for-server.sh

cd ..
scripts/update-api-types.sh
if [[ $(git status --porcelain) ]]; then
    git status --porcelain
    echo "Failing CI because the working directory is not clean after generating api types"
    exit 1
fi
cd frontend

pids=()
for i in $(seq 1 $process_count); do
    # Create a named pipe for this process
    pipe="/tmp/vaultlink_pipe_$$_$i"
    mkfifo "$pipe"

    # Start the node process writing to the pipe
    node test-client/dist/cli.js > "$pipe" 2>&1 &
    pid=$!
    pids+=($pid)
    echo "Started process $i with PID: $pid"

    # Read from pipe, prefix with PID
    (sed "s/^/[PID $pid] /" < "$pipe" > "../logs/log_${i}.log"; rm "$pipe") &
done

cd ..

print_failed_log() {
    for i in $(seq 1 $process_count); do
        if [ -n "${pids[$i-1]}" ] && ! kill -0 ${pids[$i-1]} 2>/dev/null; then
            # Get the exit code of the process
            wait ${pids[$i-1]}
            exit_code=$?

            # Only consider non-zero exit codes as failures
            if [ $exit_code -ne 0 ]; then
                echo "----- Log for process ${pids[$i-1]} (log_${i}.log) -----"
                cat "$(pwd)/logs/log_${i}.log"
                echo "Process ${pids[$i-1]} failed with exit code $exit_code. Log file: $(pwd)/logs/log_${i}.log"
                return 0
            else
                echo "Process ${pids[$i-1]} completed successfully with exit code 0"
                # Mark this PID as processed by setting it to empty
                pids[$i-1]=""
            fi
        fi
    done
    return 1
}

echo "Monitoring $process_count processes"

# Monitor processes
while true; do
    if print_failed_log; then
        # Kill remaining processes
        for pid in "${pids[@]}"; do
            if [ -n "$pid" ]; then
                kill $pid 2>/dev/null || true
            fi
        done
        exit 1
    fi

    # Check if all processes have completed
    all_done=true
    for pid in "${pids[@]}"; do
        if [ -n "$pid" ] && kill -0 $pid 2>/dev/null; then
            all_done=false
            break
        fi
    done

    if $all_done; then
        echo "All processes completed successfully"
        exit 0
    fi

    sleep 0.2
done
