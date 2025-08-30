#!/bin/bash

set -e

cd "$(dirname "$0")/../sync-server"

# Setup database
sqlx database create --database-url sqlite://db.sqlite3 2>/dev/null || true
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3

targets=${@:-"x86_64-unknown-linux-gnu x86_64-unknown-linux-musl aarch64-unknown-linux-gnu x86_64-pc-windows-gnu"}

mkdir -p artifacts
rm -f artifacts/sync-server-*


for target in $targets; do
    echo "Building $target..."
    
    # Set linkers for cross-compilation
    case "$target" in
        aarch64-unknown-linux-gnu) 
            export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc ;;
        x86_64-unknown-linux-musl) 
            export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc ;;
        x86_64-pc-windows-gnu) 
            export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc ;;
    esac
    
    rustup target add "$target" 2>/dev/null || true
    
    cargo build --release --target "$target"
    ext=""
    [[ "$target" == *windows* ]] && ext=".exe"
    
    name="sync-server-${target//-/_}$ext"
    name="${name//x86_64_unknown_linux_gnu/linux-x86_64}"
    name="${name//x86_64_unknown_linux_musl/linux-x86_64-musl}"
    name="${name//aarch64_unknown_linux_gnu/linux-aarch64}"
    name="${name//x86_64_pc_windows_gnu/windows-x86_64}"
    
    cp "target/$target/release/sync_server$ext" "artifacts/$name"
    echo "✓ Built $name"
done

ls -la ../artifacts/sync-server-*
