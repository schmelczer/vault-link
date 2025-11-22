# Advanced Configuration

Advanced topics for optimising and customising your VaultLink deployment.

## Database Optimisation

### SQLite Tuning

While VaultLink handles most SQLite configuration automatically, you can optimise for specific workloads.

#### WAL Mode

VaultLink uses Write-Ahead Logging (WAL) mode by default for better concurrency.

**Benefits**:

- Readers don't block writers
- Writers don't block readers
- Better performance for concurrent access

**Maintenance**:

```bash
# Checkpoint WAL to main database (run periodically)
sqlite3 databases/vault.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

#### Database Size Management

Over time, databases can grow with version history:

```bash
# Check database size
du -h databases/*.db

# Vacuum to reclaim space (offline only)
sqlite3 databases/vault.db "VACUUM;"

# Analyse for query optimisation
sqlite3 databases/vault.db "ANALYZE;"
```

**Schedule maintenance**:

```bash
#!/bin/bash
# monthly-maintenance.sh

for db in databases/*.db; do
    echo "Optimising $db"
    sqlite3 "$db" "PRAGMA optimize;"
    sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);"
done
```

### Version History Cleanup

To limit database growth, implement version history pruning (requires custom script):

```bash
#!/bin/bash
# prune-old-versions.sh
# Keep only last 100 versions per document

for db in databases/*.db; do
    sqlite3 "$db" <<EOF
DELETE FROM versions
WHERE id NOT IN (
    SELECT id FROM versions
    WHERE document_id = versions.document_id
    ORDER BY version DESC
    LIMIT 100
);
EOF
done
```

## Performance Tuning

### Connection Pool Sizing

Calculate optimal `max_connections_per_vault`:

```
max_connections = (concurrent_users × avg_operations_per_user) + buffer
```

**Example**:

- 20 concurrent users
- 2 operations per user on average
- 25% buffer

```
max_connections = (20 × 2) × 1.25 = 50
```

### Timeout Configuration

Adjust timeouts based on network characteristics:

**Fast local network**:

```yaml
database:
    cursor_timeout_seconds: 30

server:
    response_timeout_seconds: 30
```

**Slow or unreliable network**:

```yaml
database:
    cursor_timeout_seconds: 180

server:
    response_timeout_seconds: 120
```

**Mobile clients**:

```yaml
database:
    cursor_timeout_seconds: 300 # Longer for intermittent connections

server:
    response_timeout_seconds: 180
```

## Reverse Proxy Configuration

### Nginx with SSL

Complete Nginx configuration for production:

```nginx
# Rate limiting
limit_req_zone $binary_remote_addr zone=vaultlink:10m rate=10r/s;

upstream vaultlink {
    server localhost:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name sync.example.com;

    ssl_certificate /etc/letsencrypt/live/sync.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;

    # SSL security settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # HSTS
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Rate limiting
    limit_req zone=vaultlink burst=20 nodelay;

    # Client body size (match server config)
    client_max_body_size 512M;

    # Timeouts
    proxy_connect_timeout 90s;
    proxy_send_timeout 90s;
    proxy_read_timeout 3600s;  # WebSocket long-lived connections

    # WebSocket headers
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Disable buffering for WebSocket
    proxy_buffering off;

    location / {
        proxy_pass http://vaultlink;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://vaultlink/vaults/health/ping;
        access_log off;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name sync.example.com;
    return 301 https://$server_name$request_uri;
}
```

### Caddy with Auto SSL

Caddy handles SSL automatically:

```caddy
sync.example.com {
    reverse_proxy localhost:3000 {
        # WebSocket support
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}

        # Timeouts
        transport http {
            read_timeout 3600s
            write_timeout 90s
        }
    }

    # Rate limiting (requires caddy-rate-limit plugin)
    rate_limit {
        zone dynamic {
            match {
                remote_ip
            }
            rate 10r/s
            burst 20
        }
    }
}
```

### Traefik Configuration

Using Docker labels:

```yaml
services:
    vaultlink-server:
        image: ghcr.io/schmelczer/vault-link-server:latest
        labels:
            - "traefik.enable=true"
            - "traefik.http.routers.vaultlink.rule=Host(`sync.example.com`)"
            - "traefik.http.routers.vaultlink.entrypoints=websecure"
            - "traefik.http.routers.vaultlink.tls.certresolver=letsencrypt"
            - "traefik.http.services.vaultlink.loadbalancer.server.port=3000"
            # Middleware for timeouts
            - "traefik.http.middlewares.vaultlink-timeout.timeout.request=3600s"
```

## Docker Optimizations

### Resource Limits

Limit container resources:

```yaml
services:
    vaultlink-server:
        image: ghcr.io/schmelczer/vault-link-server:latest
        deploy:
            resources:
                limits:
                    cpus: "2.0"
                    memory: 4G
                reservations:
                    cpus: "1.0"
                    memory: 2G
```

### Logging Configuration

Optimize Docker logging:

```yaml
services:
    vaultlink-server:
        image: ghcr.io/schmelczer/vault-link-server:latest
        logging:
            driver: "json-file"
            options:
                max-size: "50m"
                max-file: "5"
```

### Volume Optimization

Use named volumes for better performance:

```yaml
services:
    vaultlink-server:
        image: ghcr.io/schmelczer/vault-link-server:latest
        volumes:
            - vaultlink-data:/data
            - vaultlink-logs:/data/logs

volumes:
    vaultlink-data:
        driver: local
        driver_opts:
            type: none
            o: bind
            device: /mnt/fast-ssd/vaultlink
    vaultlink-logs:
        driver: local
```

## High Availability

### Health Checks

Comprehensive health monitoring:

```yaml
services:
    vaultlink-server:
        image: ghcr.io/schmelczer/vault-link-server:latest
        healthcheck:
            test: ["CMD-SHELL", "curl -f http://localhost:3000/vaults/health/ping || exit 1"]
            interval: 10s
            timeout: 5s
            retries: 3
            start_period: 30s
```

Monitor health in production:

```bash
#!/bin/bash
# health-monitor.sh

while true; do
    if ! curl -sf http://localhost:3000/vaults/health/ping > /dev/null; then
        echo "Health check failed at $(date)" | mail -s "VaultLink Down" admin@example.com
        # Optionally restart
        # docker restart vaultlink-server
    fi
    sleep 30
done
```

### Backup Automation

Automated backup script:

```bash
#!/bin/bash
# backup-vaultlink.sh

BACKUP_DIR="/backup/vaultlink"
DATA_DIR="/data"
DATE=$(date +%Y%m%d-%H%M%S)
RETENTION_DAYS=30

# Create backup directory
mkdir -p "$BACKUP_DIR/$DATE"

# Backup databases (with WAL checkpoint)
for db in "$DATA_DIR"/databases/*.db; do
    sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);"
    cp "$db" "$BACKUP_DIR/$DATE/"
    [ -f "${db}-wal" ] && cp "${db}-wal" "$BACKUP_DIR/$DATE/"
    [ -f "${db}-shm" ] && cp "${db}-shm" "$BACKUP_DIR/$DATE/"
done

# Backup configuration
cp "$DATA_DIR/config.yml" "$BACKUP_DIR/$DATE/"

# Compress backup
tar -czf "$BACKUP_DIR/vaultlink-$DATE.tar.gz" -C "$BACKUP_DIR" "$DATE"
rm -rf "$BACKUP_DIR/$DATE"

# Clean old backups
find "$BACKUP_DIR" -name "vaultlink-*.tar.gz" -mtime +$RETENTION_DAYS -delete

# Upload to remote storage (optional)
# rclone copy "$BACKUP_DIR/vaultlink-$DATE.tar.gz" remote:backups/
```

Schedule with cron:

```cron
0 2 * * * /opt/vaultlink/backup-vaultlink.sh
```

### Restore from Backup

```bash
#!/bin/bash
# restore-vaultlink.sh

BACKUP_FILE="$1"
DATA_DIR="/data"

if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: $0 <backup-file.tar.gz>"
    exit 1
fi

# Stop server
docker stop vaultlink-server

# Extract backup
tar -xzf "$BACKUP_FILE" -C /tmp/
BACKUP_DATE=$(basename "$BACKUP_FILE" .tar.gz | cut -d- -f2-)

# Restore databases
cp /tmp/"$BACKUP_DATE"/databases/*.db "$DATA_DIR/databases/"

# Restore config (careful!)
# cp /tmp/$BACKUP_DATE/config.yml "$DATA_DIR/"

# Cleanup
rm -rf /tmp/"$BACKUP_DATE"

# Start server
docker start vaultlink-server

echo "Restore complete. Check server logs."
```

## Monitoring and Metrics

### Prometheus Metrics

While VaultLink doesn't expose metrics natively, monitor Docker:

```yaml
# docker-compose.yml
services:
    vaultlink-server:
        image: ghcr.io/schmelczer/vault-link-server:latest
        labels:
            - "prometheus.io/scrape=true"
            - "prometheus.io/port=3000"

    cadvisor:
        image: gcr.io/cadvisor/cadvisor:latest
        volumes:
            - /:/rootfs:ro
            - /var/run:/var/run:ro
            - /sys:/sys:ro
            - /var/lib/docker/:/var/lib/docker:ro
        ports:
            - 8080:8080
```

### Log Analysis

Analyze logs for insights:

```bash
# Most active users
grep "authenticated" logs/*.log | cut -d"'" -f2 | sort | uniq -c | sort -rn

# Failed authentications by IP
grep "Authentication failed" logs/*.log | grep -oP '\d+\.\d+\.\d+\.\d+' | sort | uniq -c | sort -rn

# Upload activity
grep "Upload:" logs/*.log | wc -l

# Average files per vault
grep "Sync complete" logs/*.log | grep -oP '\d+ files' | cut -d' ' -f1 | awk '{sum+=$1; count++} END {print sum/count}'
```

### Alerting

Simple alerting with cron:

```bash
#!/bin/bash
# alert-errors.sh

ERROR_THRESHOLD=10
ERROR_COUNT=$(grep -c "ERROR" logs/latest.log)

if [ "$ERROR_COUNT" -gt "$ERROR_THRESHOLD" ]; then
    echo "VaultLink has $ERROR_COUNT errors in the last hour" | \
        mail -s "VaultLink Alert" admin@example.com
fi
```

## Security Hardening

### Network Isolation

Run VaultLink in isolated network:

```yaml
services:
    vaultlink-server:
        image: ghcr.io/schmelczer/vault-link-server:latest
        networks:
            - vaultlink-internal
            - proxy-external

networks:
    vaultlink-internal:
        internal: true
    proxy-external:
        driver: bridge
```

### Read-Only Root Filesystem

Run with read-only root (mount writable volumes for data):

```yaml
services:
    vaultlink-server:
        image: ghcr.io/schmelczer/vault-link-server:latest
        read_only: true
        volumes:
            - ./data:/data
            - /tmp
```

### Drop Capabilities

Run with minimal privileges:

```yaml
services:
    vaultlink-server:
        image: ghcr.io/schmelczer/vault-link-server:latest
        security_opt:
            - no-new-privileges:true
        cap_drop:
            - ALL
```

## Migration

### Moving to New Server

1. **Backup on old server**:

    ```bash
    ./backup-vaultlink.sh
    ```

2. **Transfer backup**:

    ```bash
    scp vaultlink-backup.tar.gz new-server:/tmp/
    ```

3. **Restore on new server**:

    ```bash
    ./restore-vaultlink.sh /tmp/vaultlink-backup.tar.gz
    ```

4. **Update DNS/clients** to point to new server

5. **Verify sync** on all clients

### Version Upgrades

```bash
# Pull latest image
docker pull ghcr.io/schmelczer/vault-link-server:latest

# Backup first
./backup-vaultlink.sh

# Stop old container
docker stop vaultlink-server
docker rm vaultlink-server

# Start with new image
docker run -d \
  --name vaultlink-server \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ./data:/data \
  ghcr.io/schmelczer/vault-link-server:latest \
  /app/sync_server /data/config.yml

# Check logs
docker logs -f vaultlink-server
```

## Next Steps

- [Understand the architecture →](/architecture/)
- [Deploy the server →](/guide/server-setup)
- [Configure clients →](/guide/obsidian-plugin)
