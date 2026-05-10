#!/bin/bash

set -e
set -o pipefail

NO_COLOR=1
FORCE_COLOR=0

./scripts/utils/check-node.sh

# Check if the argument is provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <number_of_processes>"
    exit 1
fi

# Get the number of processes from the first argument
process_count=$1

mkdir -p logs

# Build and restart the server
echo "Building server..."
cd sync-server
cargo build --release

# Kill any existing server process
echo "Stopping existing server..."
pkill -f "sync_server" 2>/dev/null || true
sleep 1

# Clean databases (uses tmpfs via /dev/shm for zero disk I/O)
echo "Cleaning databases..."
rm -rf /tmp/databases

# Start the server in the background
echo "Starting server..."
./target/release/sync_server config-e2e.yml &
server_pid=$!
echo "Server started with PID: $server_pid"

# Ensure server is killed on script exit
cleanup_server() {
    if [ -n "$server_pid" ]; then
        echo "Stopping server (PID: $server_pid)..."
        kill $server_pid 2>/dev/null || true
        wait $server_pid 2>/dev/null || true
        server_pid=""
    fi
}
trap cleanup_server EXIT

cd ..

cd frontend
npm ci
npm run build

../scripts/utils/wait-for-server.sh

pids=()
for i in $(seq 1 $process_count); do
    node test-client/dist/cli.js > "../logs/log_${i}.log" 2>&1 &
    pid=$!
    pids+=($pid)
    echo "Started process $i with PID: $pid (log: logs/log_${i}.log)"
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

E2E_TIMEOUT=${2:-3600}
start_time=$(date +%s)
echo "Monitoring $process_count processes (timeout: ${E2E_TIMEOUT}s)"

# Monitor processes
while true; do
    # Script-level timeout to prevent indefinite hangs
    current_time=$(date +%s)
    elapsed=$((current_time - start_time))
    if [ $elapsed -ge $E2E_TIMEOUT ]; then
        echo "E2E timeout reached (${E2E_TIMEOUT}s). Killing remaining processes."
        for pid in "${pids[@]}"; do
            if [ -n "$pid" ]; then
                kill $pid 2>/dev/null || true
            fi
        done
        exit 1
    fi

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
        cleanup_server
        echo "All processes completed successfully"
        exit 0
    fi

    sleep 0.2
done
