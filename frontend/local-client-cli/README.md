# VaultLink Local CLI

A standalone command-line interface for syncing VaultLink vaults to your local filesystem. This CLI wraps the VaultLink sync client and provides file watching capabilities for real-time synchronization.

## Features

- Real-time bidirectional sync between local filesystem and VaultLink server
- File watching with automatic change detection
- Cross-platform support (Linux, macOS, Windows)
- Configuration via command-line arguments or JSON file
- Comprehensive error handling and logging
- Graceful shutdown on SIGINT/SIGTERM

## Installation

### Using Docker (Recommended)

The easiest way to run VaultLink CLI is using Docker:

```bash
docker pull ghcr.io/schmelczer/vault-link-cli:latest

# Run with all options via command line
docker run -v /path/to/vault:/vault \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault \
  -r https://sync.example.com \
  -t your-auth-token \
  -v default

# Or use a config file
docker run -v /path/to/vault:/vault \
  -v /path/to/config.json:/config.json \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault \
  -c /config.json
```

### Using Docker Compose

```yaml
version: '3.8'

services:
  vaultlink-cli:
    image: ghcr.io/schmelczer/vault-link-cli:latest
    volumes:
      - ./vault:/vault
      - ./config.json:/config.json
    command: -l /vault -c /config.json
    restart: unless-stopped
```

### From npm Package

```bash
npm install -g @schmelczer/local-client-cli
vaultlink --help
```

### From Source

```bash
cd frontend/local-client-cli
npm install
npm run build
node dist/cli.js --help
```

## Usage

### Basic Usage

```bash
vaultlink \
  --local-path ./my-vault \
  --remote-uri https://sync.example.com \
  --token your-auth-token \
  --vault-name default
```

### Using a Configuration File

Create a `config.json` file:

```json
{
  "remoteUri": "https://sync.example.com",
  "token": "your-auth-token",
  "vaultName": "default",
  "syncConcurrency": 1,
  "maxFileSizeMB": 10,
  "ignorePatterns": [".git/**", "*.tmp"],
  "webSocketRetryIntervalMs": 3500
}
```

Then run:

```bash
vaultlink --local-path ./my-vault --config config.json
```

### Command-Line Options

#### Required Arguments

- `-l, --local-path <PATH>` - Local directory path to sync
- `-r, --remote-uri <URI>` - Remote server URI (unless using --config)
- `-t, --token <TOKEN>` - Authentication token (unless using --config)
- `-v, --vault-name <NAME>` - Vault name (unless using --config)

#### Optional Arguments

- `-c, --config <FILE>` - Load configuration from JSON file
- `--sync-concurrency <NUM>` - Number of concurrent sync operations (default: 1)
- `--max-file-size-mb <NUM>` - Maximum file size in MB (default: 10)
- `--ignore-pattern <PATTERN>` - Pattern to ignore (can be used multiple times)
- `--websocket-retry-interval-ms <NUM>` - WebSocket retry interval in ms (default: 3500)
- `-h, --help` - Print help message
- `-V, --version` - Print version

### Ignore Patterns

Ignore patterns support glob syntax. The CLI automatically ignores:

- `.vaultlink/**` - Internal sync data directory
- `.git/**` - Git repository files

You can add additional patterns:

```bash
vaultlink \
  --local-path ./my-vault \
  --remote-uri https://sync.example.com \
  --token mytoken \
  --vault-name default \
  --ignore-pattern "*.tmp" \
  --ignore-pattern ".DS_Store" \
  --ignore-pattern "node_modules/**"
```

## Docker Deployment

### Self-Hosting with Docker

The CLI is designed to run as a long-lived container:

```bash
# Create a vault directory
mkdir -p ./vault

# Create config.json
cat > config.json <<EOF
{
  "remoteUri": "https://your-server.com",
  "token": "your-token",
  "vaultName": "default"
}
EOF

# Run the container
docker run -d \
  --name vaultlink-sync \
  --restart unless-stopped \
  -v $(pwd)/vault:/vault \
  -v $(pwd)/config.json:/config.json \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault -c /config.json
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vaultlink-cli
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vaultlink-cli
  template:
    metadata:
      labels:
        app: vaultlink-cli
    spec:
      containers:
      - name: vaultlink-cli
        image: ghcr.io/schmelczer/vault-link-cli:latest
        args:
          - "-l"
          - "/vault"
          - "-c"
          - "/config/config.json"
        volumeMounts:
        - name: vault
          mountPath: /vault
        - name: config
          mountPath: /config
      volumes:
      - name: vault
        persistentVolumeClaim:
          claimName: vaultlink-pvc
      - name: config
        configMap:
          name: vaultlink-config
```

## How It Works

1. **Initialization**: The CLI creates a `.vaultlink` directory in your local path to store sync metadata and state
2. **Initial Sync**: On first run, all local files are synced to the server
3. **File Watching**: The CLI watches for file system changes using Node's `fs.watch` API
4. **Real-time Sync**: Any local changes are automatically synced to the server, and server changes are applied locally
5. **Graceful Shutdown**: On Ctrl+C or termination signals, the CLI waits for pending operations to complete

## Development

### Building

```bash
npm run build
# or from the parent folder, run
docker build -f local-client-cli/Dockerfile  .
```

### Development Mode with Watch

```bash
npm run dev
```

### Running Tests

```bash
npm test
```

Tests cover:
- Filesystem operations (read, write, delete, rename, etc.)
- CLI argument parsing and validation
- Cross-platform path handling
- Error handling

## Architecture

The CLI consists of several key components:

- **`cli.ts`**: Main entry point, orchestrates initialization and lifecycle
- **`node-filesystem.ts`**: Node.js filesystem adapter implementing the `FileSystemOperations` interface with cross-platform path normalization
- **`file-watcher.ts`**: Watches filesystem changes and triggers sync operations
- **`args.ts`**: Command-line argument parser using `commander` library
- **`config-loader.ts`**: JSON configuration file loader and merger

### Dependencies

- **commander**: Industry-standard CLI argument parsing with built-in help generation and validation
- **sync-client**: Core VaultLink synchronization library

### Path Handling

The filesystem adapter ensures cross-platform compatibility by:
- **API Contract**: Always accepts forward slashes (`/`) as input
- **API Contract**: Always returns forward slashes (`/`) as output
- **Implementation**: Converts between forward slashes and platform-native separators internally
- **Windows Support**: Automatically converts `/` to `\` on Windows for filesystem operations

## Error Handling

The CLI provides robust error handling:

- Invalid arguments result in clear error messages and exit code 1
- Connection failures are reported before starting sync
- File operation errors are logged with context
- Graceful shutdown ensures no data loss on termination

## Cross-Platform Support

The CLI is built with cross-platform compatibility:

- Uses Node's `path` module for platform-agnostic path handling
- Automatically detects platform line endings (CRLF on Windows, LF on Unix)
- File watching works on all platforms through Node's native `fs.watch`
- Compiled with Webpack for Node target, ensuring broad compatibility
- Path normalization ensures consistent behavior across Windows, macOS, and Linux

