# CLI Client

Sync vaults without Obsidian. Works on servers, automation, backups, headless systems.

## Installation

### Docker (Recommended)

Pull the latest image:

```bash
docker pull ghcr.io/schmelczer/vault-link-cli:latest
```

### npm

Install globally:

```bash
npm install -g @schmelczer/local-client-cli
```

Verify installation:

```bash
vaultlink --version
```

### From Source

Build from the repository:

```bash
git clone https://github.com/schmelczer/vault-link.git
cd vault-link/frontend/local-client-cli
npm install
npm run build
node dist/cli.js --help
```

## Usage

### Basic Usage

```bash
vaultlink \
  --local-path /path/to/vault \
  --remote-uri wss://sync.example.com \
  --token your-auth-token \
  --vault-name default
```

### Docker Usage

```bash
docker run -v /path/to/vault:/vault \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault \
  -r wss://sync.example.com \
  -t your-auth-token \
  -v default
```

### Docker Compose

Create `docker-compose.yml`:

```yaml
services:
    vaultlink-cli:
        image: ghcr.io/schmelczer/vault-link-cli:latest
        restart: unless-stopped
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
```

Start the client:

```bash
docker compose up -d
```

## Configuration Options

### Required Arguments

| Argument       | Short | Description             | Example                  |
| -------------- | ----- | ----------------------- | ------------------------ |
| `--local-path` | `-l`  | Local directory to sync | `/vault`                 |
| `--remote-uri` | `-r`  | Server WebSocket URI    | `wss://sync.example.com` |
| `--token`      | `-t`  | Authentication token    | `abc123...`              |
| `--vault-name` | `-v`  | Vault name on server    | `default`                |

### Optional Arguments

| Argument                        | Default | Description                            |
| ------------------------------- | ------- | -------------------------------------- |
| `--sync-concurrency`            | `1`     | Concurrent file operations             |
| `--max-file-size-mb`            | `10`    | Max file size in MB                    |
| `--ignore-pattern`              | -       | Glob pattern to ignore (repeatable)    |
| `--websocket-retry-interval-ms` | `3500`  | Reconnection interval                  |
| `--log-level`                   | `INFO`  | Log level: DEBUG, INFO, WARNING, ERROR |

### Environment Variables

Alternative to command-line arguments:

```bash
export VAULTLINK_LOCAL_PATH="/vault"
export VAULTLINK_REMOTE_URI="wss://sync.example.com"
export VAULTLINK_TOKEN="your-token"
export VAULTLINK_VAULT_NAME="default"

vaultlink
```

## Examples

### Basic Sync

Sync a local directory to the server:

```bash
vaultlink \
  -l ./my-notes \
  -r wss://sync.example.com \
  -t my-secure-token \
  -v personal
```

### With Ignore Patterns

Exclude specific files or directories:

```bash
vaultlink \
  -l ./vault \
  -r wss://sync.example.com \
  -t token123 \
  -v default \
  --ignore-pattern "*.tmp" \
  --ignore-pattern ".DS_Store" \
  --ignore-pattern "node_modules/**"
```

### Debug Logging

Enable verbose logging:

```bash
vaultlink \
  -l ./vault \
  -r wss://sync.example.com \
  -t token123 \
  -v default \
  --log-level DEBUG
```

### High Concurrency

Faster initial sync:

```bash
vaultlink \
  -l ./vault \
  -r wss://sync.example.com \
  -t token123 \
  -v default \
  --sync-concurrency 5
```

### Large Files

Allow larger file uploads:

```bash
vaultlink \
  -l ./vault \
  -r wss://sync.example.com \
  -t token123 \
  -v default \
  --max-file-size-mb 50
```

## Docker Deployment

### Long-Running Sync

Run as a daemon for continuous synchronisation:

```bash
docker run -d \
  --name vaultlink-sync \
  --restart unless-stopped \
  -v $(pwd)/vault:/vault \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault \
  -r wss://sync.example.com \
  -t your-token \
  -v default
```

Monitor logs:

```bash
docker logs -f vaultlink-sync
```

### Health Monitoring

The Docker image includes built-in health checks:

```bash
# Check health status
docker ps

# View detailed health info
docker inspect --format='{{json .State.Health}}' vaultlink-sync | jq
```

Health check verifies:

- Health file exists
- Status updated within last 30 seconds
- WebSocket connection is active

Configure custom health check:

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

### Read-Only Vault

Mount vault as read-only to prevent local changes:

```bash
docker run -d \
  -v $(pwd)/vault:/vault:ro \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault \
  -r wss://sync.example.com \
  -t token \
  -v default
```

::: warning
The CLI needs write access to create `.vaultlink` metadata directory. Mount as read-write or provide a separate writeable directory.
:::

## How It Works

### Initial Sync

On startup:

1. Creates `.vaultlink/` directory for metadata
2. Scans local filesystem
3. Uploads all local files to server
4. Downloads files from server not present locally
5. Resolves conflicts using operational transformation

### Real-Time Synchronization

After initial sync:

1. Watches filesystem for changes using `fs.watch`
2. Uploads changed files immediately
3. Receives real-time updates from server via WebSocket
4. Handles bidirectional sync automatically

### Graceful Shutdown

On SIGINT (Ctrl+C) or SIGTERM:

1. Completes pending uploads
2. Closes WebSocket connection cleanly
3. Flushes metadata to disk
4. Exits gracefully

## Use Cases

### Automated Backups

Continuously backup vaults to a remote server:

```bash
docker run -d \
  --name vault-backup \
  -v /important/notes:/vault:ro \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault -r wss://backup.example.com -t backup-token -v backups
```

### CI/CD Documentation

Sync documentation in automated pipelines:

```bash
# In your CI pipeline
docker run \
  -v $(pwd)/docs:/vault \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault -r wss://docs.example.com -t ci-token -v prod-docs
```

### Multi-Location Sync

Sync between different geographic locations:

```bash
# Location A
vaultlink -l /data/vault -r wss://hub.example.com -t token -v shared

# Location B
vaultlink -l /backup/vault -r wss://hub.example.com -t token -v shared
```

### Development Environment

Keep documentation in sync across dev environments:

```bash
# In docker-compose.yml for your dev stack
services:
  docs-sync:
    image: ghcr.io/schmelczer/vault-link-cli:latest
    volumes:
      - ./docs:/vault
    command: ["-l", "/vault", "-r", "wss://docs-server", "-t", "dev-token", "-v", "dev"]
```

## Troubleshooting

### Client won't connect

**Check server accessibility**:

```bash
curl https://sync.example.com/vaults/test/ping
```

**Verify WebSocket protocol**:

- Use `ws://` for HTTP servers
- Use `wss://` for HTTPS servers

**Check authentication**:

- Token must match server config
- User must have access to the vault

### Permission errors

**Docker volume permissions**:

```bash
# Ensure directory is writable
chmod 755 /path/to/vault

# Check Docker user ID
docker run --rm ghcr.io/schmelczer/vault-link-cli:latest id
```

**SELinux issues**:

```bash
# Add :z flag to volume mount
docker run -v /path/to/vault:/vault:z ...
```

### Files not syncing

**Check ignore patterns**:

- View logs to see which files are skipped
- Ensure patterns don't match unintentionally

**File size limits**:

- Check `--max-file-size-mb` setting
- Large files are skipped with a warning

**Check metadata**:

```bash
# View sync metadata
cat /path/to/vault/.vaultlink/metadata.json
```

### High memory usage

**Reduce concurrency**:

```bash
--sync-concurrency 1
```

**Limit file sizes**:

```bash
--max-file-size-mb 5
```

**Check vault size**:

- Very large vaults may need more resources
- Consider splitting into multiple vaults

### Connection keeps dropping

**Increase retry interval**:

```bash
--websocket-retry-interval-ms 5000
```

**Check network stability**:

```bash
# Monitor connection
docker logs -f vaultlink-sync | grep -i websocket
```

**Server timeout settings**:

- Verify reverse proxy WebSocket timeout
- Check server `response_timeout_seconds`

## Advanced Usage

### Custom Healthcheck Script

Create your own health monitoring:

```bash
#!/bin/bash
HEALTH_FILE="/tmp/vaultlink-health.json"

if [ ! -f "$HEALTH_FILE" ]; then
    exit 1
fi

# Check file is recent (within 60 seconds)
if [ $(( $(date +%s) - $(stat -c %Y "$HEALTH_FILE") )) -gt 60 ]; then
    exit 1
fi

# Check WebSocket is connected
if ! jq -e '.connected == true' "$HEALTH_FILE" > /dev/null; then
    exit 1
fi

exit 0
```

### Automated Recovery

Restart on failure with exponential backoff:

```bash
#!/bin/bash
RETRY_DELAY=5

while true; do
    vaultlink -l /vault -r wss://server -t token -v default

    echo "Client exited, restarting in ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY

    # Exponential backoff up to 5 minutes
    RETRY_DELAY=$((RETRY_DELAY * 2))
    if [ $RETRY_DELAY -gt 300 ]; then
        RETRY_DELAY=300
    fi
done
```

### Integration with systemd

Create `/etc/systemd/system/vaultlink-cli.service`:

```ini
[Unit]
Description=VaultLink CLI Sync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=10
Environment="VAULTLINK_LOCAL_PATH=/data/vault"
Environment="VAULTLINK_REMOTE_URI=wss://sync.example.com"
Environment="VAULTLINK_TOKEN=your-token"
Environment="VAULTLINK_VAULT_NAME=default"
ExecStart=/usr/local/bin/vaultlink

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable vaultlink-cli
sudo systemctl start vaultlink-cli
```

## Next Steps

- [Configure server authentication →](/config/authentication)
- [Learn about the sync algorithm →](/architecture/sync-algorithm)
- [Set up Obsidian plugin →](/guide/obsidian-plugin)
