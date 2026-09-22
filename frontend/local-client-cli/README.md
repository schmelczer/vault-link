# VaultLink Local CLI

Standalone CLI for syncing VaultLink vaults to local filesystem with real-time bidirectional sync and file watching.

## Installation

### Docker (Recommended)

```bash
docker pull ghcr.io/schmelczer/vault-link-cli:latest

docker run -v /path/to/vault:/vault \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault \
  -r wss://sync.example.com \
  -t your-auth-token \
  -v default
```

### npm

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

```bash
vaultlink \
  --local-path ./vault \
  --remote-uri wss://sync.example.com \
  --token your-auth-token \
  --vault-name default
```

## Options

### Required

| Option                    | Description                                   |
| ------------------------- | --------------------------------------------- |
| `-l, --local-path <path>` | Local directory to sync                       |
| `-r, --remote-uri <uri>`  | Remote server WebSocket URI (ws:// or wss://) |
| `-t, --token <token>`     | Authentication token                          |
| `-v, --vault-name <name>` | Vault name on server                          |

### Optional

| Option                               | Default | Description                                     |
| ------------------------------------ | ------- | ----------------------------------------------- |
| `--max-file-size-mb <number>`        | `10`    | Maximum file size in MB                         |
| `--ignore-pattern <pattern>`         | -       | Glob pattern to ignore (repeatable)             |
| `--websocket-retry-interval-ms <ms>` | `3500`  | WebSocket reconnection interval                 |
| `--log-level <level>`                | `INFO`  | Log level: DEBUG, INFO, WARNING, ERROR          |
| `-q, --quiet`                        | -       | Suppress startup banner for non-interactive use |
| `-h, --help`                         | -       | Show help                                       |
| `-V, --version`                      | -       | Show version                                    |

### Auto-Ignored Patterns

- `.vaultlink/**` - Internal sync metadata
- `.git/**` - Git repository files

### Examples

Basic usage:

```bash
vaultlink -l ./vault -r wss://sync.example.com -t token123 -v default
```

With ignore patterns:

```bash
vaultlink -l ./vault -r wss://sync.example.com -t token123 -v default \
  --ignore-pattern "**/*.tmp" \
  --ignore-pattern ".DS_Store" \
  --ignore-pattern "node_modules/**"
```

With debug logging and quiet startup:

```bash
vaultlink -l ./vault -r wss://sync.example.com -t token123 -v default \
  --log-level DEBUG --quiet
```

File bytes, including line endings, are preserved on every platform.

## Docker Deployment

### Docker Run

```bash
docker run -d \
  --name vaultlink-sync \
  --restart unless-stopped \
  -v $(pwd)/vault:/vault \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault \
  -r wss://your-server.com \
  -t your-token \
  -v default
```

### Docker Compose

```yaml
services:
  vaultlink-cli:
    image: ghcr.io/schmelczer/vault-link-cli:latest
    volumes:
      - ./vault:/vault
    command:
      - "-l"
      - "/vault"
      - "-r"
      - "wss://sync.example.com"
      - "-t"
      - "your-token"
      - "-v"
      - "default"
    restart: unless-stopped
```

## Health Monitoring

The Docker container includes a built-in healthcheck that monitors the WebSocket connection to the server.

### Healthcheck Configuration

- **Interval**: 30 seconds
- **Timeout**: 10 seconds
- **Start period**: 30 seconds (grace period for initial connection)
- **Retries**: 3 failed checks before marking unhealthy

### How It Works

The CLI writes connection status to `/tmp/vaultlink-health.json` every 10 seconds and whenever the WebSocket connection status changes. The healthcheck script verifies:

1. The health file exists
2. The status is recent (updated within last 30 seconds)
3. The WebSocket connection is active

### Checking Container Health

```bash
# View health status
docker ps

# View detailed health check logs
docker inspect --format='{{json .State.Health}}' vaultlink-sync | jq
```

### Custom Healthcheck

To override the default healthcheck in docker-compose.yml:

```yaml
services:
  vaultlink-cli:
    image: ghcr.io/schmelczer/vault-link-cli:latest
    healthcheck:
      test: ["CMD", "node", "/app/healthcheck.js"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 20s
```

## Development

Build:

```bash
npm run build
# or from the parent folder, run
docker build -f local-client-cli/Dockerfile  .
```

Test:

```bash
npm test
```

Docker build:

```bash
cd frontend
docker build -f local-client-cli/Dockerfile -t vault-link-cli:test .
```

## How It Works

1. Creates `.vaultlink` directory for sync metadata
2. Performs initial sync of local files to server
3. Uses filesystem events to wake a fresh scan, including atomic editor saves
4. Syncs changes bidirectionally in real-time
5. Handles graceful shutdown on SIGINT/SIGTERM

The complete client record (database, settings, queued logical notifications and
server history checkpoint) is saved atomically in `.vaultlink/sync-data.json`.
Existing database-only files migrate on the next save. Invalid or unreadable
metadata is reported instead of silently starting with empty state.

File moves use an exclusive copy followed by deletion of the source. An
interruption may leave both files; the next scan reconciles the visible files.
Raw watcher events do not distinguish user edits from sync writes. A rename
preserves identity when the scan finds a unique matching nonempty content hash;
a simultaneous rename and edit may instead appear as deletion and creation.

## License

MIT
