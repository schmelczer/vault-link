# Server Setup

Deploy VaultLink server via Docker, binary, or build from source.

## Deployment Options

### Docker (Recommended)

Easiest deployment path, includes health checks.

#### Basic Docker Deployment

```bash
# Pull the latest image
docker pull ghcr.io/schmelczer/vault-link-server:latest

# Create data directory
mkdir -p ~/vaultlink-data

# Create config.yml (see Configuration section below)

# Run the container
docker run -d \
  --name vaultlink-server \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ~/vaultlink-data:/data \
  ghcr.io/schmelczer/vault-link-server:latest \
  /app/sync_server /data/config.yml
```

#### Docker Compose

Create `docker-compose.yml`:

```yaml
services:
    vaultlink-server:
        image: ghcr.io/schmelczer/vault-link-server:latest
        container_name: vaultlink-server
        restart: unless-stopped
        ports:
            - "3000:3000"
        volumes:
            - ./data:/data
        command: ["/app/sync_server", "/data/config.yml"]
        healthcheck:
            test: ["CMD", "curl", "-f", "http://localhost:3000/vaults/fake/ping"]
            interval: 30s
            timeout: 5s
            retries: 3
            start_period: 10s
```

Start the server:

```bash
docker compose up -d
```

### Binary Installation

Download pre-built binaries from [GitHub Releases](https://github.com/schmelczer/vault-link/releases):

```bash
# Download the binary for your platform
wget https://github.com/schmelczer/vault-link/releases/latest/download/sync_server-linux-x86_64

# Make executable
chmod +x sync_server-linux-x86_64

# Run the server
./sync_server-linux-x86_64 config.yml
```

### Build from Source

Requirements: Rust 1.89.0+, SQLite development headers, SQLx CLI

```bash
# Clone the repository
git clone https://github.com/schmelczer/vault-link.git
cd vault-link/sync-server

# Install SQLx CLI
cargo install sqlx-cli

# Set up the database
sqlx database create --database-url sqlite://db.sqlite3
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
cargo sqlx prepare --workspace

# Build in release mode
cargo build --release

# Run the server
./target/release/sync_server config.yml
```

## Configuration

Create a `config.yml` file with your server configuration:

```yaml
database:
    databases_directory_path: databases
    max_connections_per_vault: 12
    cursor_timeout_seconds: 60

server:
    host: 0.0.0.0
    port: 3000
    max_body_size_mb: 512
    max_clients_per_vault: 256
    response_timeout_seconds: 60

users:
    user_configs:
        - name: admin
          token: your-secure-random-token-here
          vault_access:
              type: allow_access_to_all

logging:
    log_directory: logs
    log_rotation: 7days
```

### Configuration Fields

#### Database

- `databases_directory_path`: Directory for SQLite databases (one per vault)
- `max_connections_per_vault`: Maximum concurrent database connections
- `cursor_timeout_seconds`: How long to keep database cursors alive

#### Server

- `host`: Bind address (use `0.0.0.0` for all interfaces)
- `port`: Port to listen on (default: 3000)
- `max_body_size_mb`: Maximum upload size
- `max_clients_per_vault`: Concurrent client limit per vault
- `response_timeout_seconds`: Request timeout

#### Users

See [Authentication Configuration →](/config/authentication) for detailed user setup.

#### Logging

- `log_directory`: Where to store log files
- `log_rotation`: How often to rotate logs (e.g., `7days`, `24hours`)

## Production Deployment

### SSL/TLS with Reverse Proxy

VaultLink doesn't handle SSL directly. Use a reverse proxy like Nginx or Caddy.

#### Nginx Configuration

```nginx
upstream vaultlink {
    server localhost:3000;
}

server {
    listen 443 ssl http2;
    server_name sync.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://vaultlink;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket specific
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

#### Caddy Configuration

Caddy handles SSL automatically:

```caddy
sync.example.com {
    reverse_proxy localhost:3000
}
```

Start Caddy:

```bash
caddy run --config Caddyfile
```

### Systemd Service

Create `/etc/systemd/system/vaultlink.service`:

```ini
[Unit]
Description=VaultLink Sync Server
After=network.target

[Service]
Type=simple
User=vaultlink
WorkingDirectory=/opt/vaultlink
ExecStart=/opt/vaultlink/sync_server /opt/vaultlink/config.yml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable vaultlink
sudo systemctl start vaultlink
sudo systemctl status vaultlink
```

### Security Best Practices

1. **Use strong tokens**: Generate with `openssl rand -hex 32`
2. **Enable firewall**: Only expose port 3000 to reverse proxy
3. **Regular updates**: Keep Docker images and binaries updated
4. **Backup databases**: SQLite files in `databases_directory_path`
5. **Monitor logs**: Check log directory for errors and anomalies
6. **Limit access**: Use vault-specific access controls per user

### Backup Strategy

The SQLite databases contain all vault data and history:

```bash
# Backup script
#!/bin/bash
BACKUP_DIR="/backup/vaultlink/$(date +%Y%m%d)"
DATA_DIR="/data/databases"

mkdir -p "$BACKUP_DIR"
cp -r "$DATA_DIR" "$BACKUP_DIR/"

# Keep 30 days of backups
find /backup/vaultlink -type d -mtime +30 -exec rm -rf {} +
```

Run daily via cron:

```cron
0 2 * * * /opt/vaultlink/backup.sh
```

### Monitoring

#### Health Checks

The server exposes a ping endpoint:

```bash
curl http://localhost:3000/vaults/fake/ping
# Returns: pong
```

Docker health check is built-in and checks this endpoint every 30 seconds.

#### Prometheus Metrics

For advanced monitoring, collect Docker stats or implement custom metrics.

#### Log Monitoring

Logs are written to the configured `log_directory`. Monitor for:

- Connection failures
- Authentication errors
- Database errors
- WebSocket disconnections

Example log watching:

```bash
tail -f /data/logs/*.log | grep -i error
```

## Scaling

### Horizontal Scaling

VaultLink currently uses SQLite, which limits horizontal scaling. For multiple servers:

1. Run separate instances for different vaults
2. Use load balancer with sticky sessions (same vault → same server)
3. Consider database architecture for your scale needs

### Vertical Scaling

Increase resources for the server:

- More CPU for handling concurrent connections
- More RAM for database caching
- Faster storage (SSD) for database operations

Tune configuration:

- Increase `max_clients_per_vault` for more concurrent users
- Increase `max_connections_per_vault` for database performance
- Adjust `max_body_size_mb` based on typical file sizes

## Troubleshooting

### Server won't start

```bash
# Check Docker logs
docker logs vaultlink-server

# Common issues:
# - Port already in use: Change port mapping
# - Config syntax error: Validate YAML
# - Permission error: Check volume permissions
```

### High memory usage

- Reduce `max_connections_per_vault`
- Reduce `max_clients_per_vault`
- Check for large vaults (may need database optimisation)

### Database corruption

```bash
# Verify database integrity
sqlite3 databases/your-vault.db "PRAGMA integrity_check;"

# If corrupted, restore from backup
cp /backup/databases/your-vault.db /data/databases/
```

### WebSocket connection drops

- Check reverse proxy timeout settings
- Verify firewall isn't closing connections
- Review client retry intervals
- Check server logs for errors

## Next Steps

- [Configure authentication and access control →](/config/authentication)
- [Set up Obsidian plugin →](/guide/obsidian-plugin)
- [Deploy CLI client →](/guide/cli-client)
- [Understand the architecture →](/architecture/)
