# Server Configuration

Complete reference for configuring the VaultLink sync server via `config.yml`.

## Configuration File Format

The server is configured using a YAML file passed as a command-line argument:

```bash
/app/sync_server /path/to/config.yml
```

## Complete Example

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
    token: your-secure-random-token
    vault_access:
      type: allow_access_to_all
  - name: alice
    token: alice-token
    vault_access:
      type: allow_list
      allowed:
        - personal
        - shared
  - name: bob
    token: bob-token
    vault_access:
      type: deny_list
      denied:
        - restricted

logging:
  log_directory: logs
  log_rotation: 7days
```

## Database Section

### `databases_directory_path`

**Type**: String
**Required**: Yes
**Default**: None

Directory where SQLite database files are stored. One database file per vault.

```yaml
database:
  databases_directory_path: /data/databases
```

The directory structure:
```
databases/
├── vault-1.db
├── vault-2.db
└── personal.db
```

**Notes**:
- Path is relative to working directory or absolute
- Directory must be writable by the server process
- Ensure adequate disk space for vault data
- Back up this directory regularly

### `max_connections_per_vault`

**Type**: Integer
**Required**: Yes
**Default**: None
**Recommended**: 12

Maximum concurrent database connections per vault.

```yaml
database:
  max_connections_per_vault: 12
```

**Tuning**:
- Higher values: Better performance under load
- Lower values: Less memory usage
- Typical range: 8-20
- Consider: Number of concurrent users × average operations per user

### `cursor_timeout_seconds`

**Type**: Integer
**Required**: Yes
**Default**: None
**Recommended**: 60

How long to keep database cursors alive for inactive clients.

```yaml
database:
  cursor_timeout_seconds: 60
```

**Notes**:
- Cursors track client sync state
- Timeout too short: Clients may need to re-sync frequently
- Timeout too long: More memory usage
- Typical range: 30-300 seconds

## Server Section

### `host`

**Type**: String
**Required**: Yes
**Default**: None

Network interface to bind the server to.

```yaml
server:
  host: 0.0.0.0  # All interfaces
  # OR
  host: 127.0.0.1  # Localhost only
  # OR
  host: 192.168.1.100  # Specific interface
```

**Common values**:
- `0.0.0.0`: Listen on all network interfaces (production)
- `127.0.0.1`: Listen on localhost only (development/testing)
- Specific IP: Listen on specific interface

### `port`

**Type**: Integer
**Required**: Yes
**Default**: None
**Recommended**: 3000

TCP port to listen on.

```yaml
server:
  port: 3000
```

**Notes**:
- Must be available (not in use)
- Privileged ports (< 1024) require root
- Common ports: 3000, 8080, 8888
- Configure firewall to allow this port

### `max_body_size_mb`

**Type**: Integer
**Required**: Yes
**Default**: None
**Recommended**: 512

Maximum size of HTTP request body in megabytes.

```yaml
server:
  max_body_size_mb: 512
```

**Usage**:
- Limits file upload size
- Prevents memory exhaustion attacks
- Must be larger than largest expected file
- Consider client `max_file_size_mb` settings

**Tuning**:
- Small vaults (mostly text): 100 MB
- Medium vaults (some images): 512 MB
- Large vaults (many images/PDFs): 1024+ MB

### `max_clients_per_vault`

**Type**: Integer
**Required**: Yes
**Default**: None
**Recommended**: 256

Maximum concurrent clients per vault.

```yaml
server:
  max_clients_per_vault: 256
```

**Notes**:
- Limits concurrent WebSocket connections
- Prevents resource exhaustion
- Consider expected number of users
- Each client uses memory and file descriptors

**Scaling**:
- Personal use: 10-50
- Small team: 50-100
- Large team: 100-500

### `response_timeout_seconds`

**Type**: Integer
**Required**: Yes
**Default**: None
**Recommended**: 60

Maximum time to wait for client responses.

```yaml
server:
  response_timeout_seconds: 60
```

**Usage**:
- Timeout for HTTP requests
- Timeout for WebSocket operations
- Clients disconnected if unresponsive

**Tuning**:
- Fast networks: 30 seconds
- Slow networks: 90-120 seconds
- Large file uploads: Increase proportionally

## Users Section

See [Authentication Configuration →](/config/authentication) for detailed user configuration.

## Logging Section

### `log_directory`

**Type**: String
**Required**: Yes
**Default**: None

Directory where log files are written.

```yaml
logging:
  log_directory: /data/logs
  # OR
  log_directory: logs  # Relative to working directory
```

**Notes**:
- Path is relative to working directory or absolute
- Directory must be writable
- Logs are rotated based on `log_rotation`
- Monitor disk usage

### `log_rotation`

**Type**: String
**Required**: Yes
**Default**: None

How often to rotate log files.

```yaml
logging:
  log_rotation: 7days
  # OR
  log_rotation: 24hours
  # OR
  log_rotation: 30days
```

**Format**: `<number><unit>`

**Units**:
- `hours`: Hours (e.g., `12hours`, `24hours`)
- `days`: Days (e.g., `7days`, `30days`)

**Recommendations**:
- Development: `24hours` or `7days`
- Production: `7days` or `30days`
- High traffic: `24hours` (logs can be large)

## Environment-Specific Configurations

### Development

```yaml
database:
  databases_directory_path: ./databases
  max_connections_per_vault: 8
  cursor_timeout_seconds: 30

server:
  host: 127.0.0.1
  port: 3000
  max_body_size_mb: 100
  max_clients_per_vault: 10
  response_timeout_seconds: 30

users:
  user_configs:
  - name: dev
    token: dev-token
    vault_access:
      type: allow_access_to_all

logging:
  log_directory: logs
  log_rotation: 24hours
```

### Production

```yaml
database:
  databases_directory_path: /data/databases
  max_connections_per_vault: 16
  cursor_timeout_seconds: 120

server:
  host: 0.0.0.0
  port: 3000
  max_body_size_mb: 512
  max_clients_per_vault: 256
  response_timeout_seconds: 90

users:
  user_configs:
  - name: admin
    token: <strong-random-token>
    vault_access:
      type: allow_access_to_all
  # Additional users...

logging:
  log_directory: /data/logs
  log_rotation: 7days
```

## Validation

The server validates configuration on startup:

```bash
# Start server
./sync_server config.yml

# Check for errors in logs
tail -f logs/latest.log
```

**Common errors**:
- Missing required fields
- Invalid YAML syntax
- Invalid values (negative numbers, etc.)
- Directory not writable

## Performance Tuning

### High Concurrency

For many concurrent users:

```yaml
database:
  max_connections_per_vault: 20  # Increase

server:
  max_clients_per_vault: 500  # Increase
  response_timeout_seconds: 120  # Increase for slow clients
```

### Large Files

For vaults with large files:

```yaml
server:
  max_body_size_mb: 1024  # Allow larger uploads
  response_timeout_seconds: 180  # More time for uploads
```

### Resource-Constrained Systems

For limited CPU/memory:

```yaml
database:
  max_connections_per_vault: 6  # Reduce

server:
  max_clients_per_vault: 50  # Reduce
  max_body_size_mb: 256  # Reduce
```

## Security Considerations

### Token Security

- Use strong random tokens: `openssl rand -hex 32`
- Never commit tokens to version control
- Rotate tokens periodically
- Use different tokens per user

### Network Security

- Bind to `127.0.0.1` if using reverse proxy on same host
- Use firewall to restrict access
- Enable SSL/TLS via reverse proxy

### Resource Limits

- Set `max_clients_per_vault` to prevent DoS
- Set `max_body_size_mb` to prevent memory exhaustion
- Configure `response_timeout_seconds` to prevent hanging connections

## Troubleshooting

### Server won't start

**Check YAML syntax**:
```bash
# Use a YAML validator
python -c 'import yaml, sys; yaml.safe_load(open("config.yml"))'
```

**Check file paths**:
```bash
# Ensure directories exist and are writable
mkdir -p databases logs
chmod 755 databases logs
```

**Check port availability**:
```bash
# Verify port is not in use
lsof -i :3000
```

### High memory usage

- Reduce `max_connections_per_vault`
- Reduce `max_clients_per_vault`
- Reduce `max_body_size_mb`
- Check for large vaults or many concurrent users

### Slow performance

- Increase `max_connections_per_vault`
- Increase database connection pool
- Use SSD for database storage
- Monitor database size (vacuum if needed)

## Next Steps

- [Configure authentication →](/config/authentication)
- [Advanced configuration options →](/config/advanced)
- [Deploy the server →](/guide/server-setup)
