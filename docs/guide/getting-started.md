# Getting Started

Set up VaultLink in 5 minutes. Deploy server, connect clients, done.

## Prerequisites

- Docker (or Rust toolchain if building from source)
- A server (VPS, home server, or localhost for testing)

## Step 1: Deploy Server

Create `config.yml`:

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
          token: change-this-to-secure-random-token
          vault_access:
              type: allow_access_to_all
logging:
    log_directory: logs
    log_rotation: 7days
```

::: tip
Generate secure token: `openssl rand -hex 32`
:::

Run server:

```bash
docker run -d \
  --name vaultlink-server \
  --restart unless-stopped \
  -p 3000:3000 \
  -v $(pwd):/data \
  ghcr.io/schmelczer/vault-link-server:latest \
  /app/sync_server /data/config.yml
```

Verify: `curl http://localhost:3000/vaults/test/ping` should return `pong`

## Step 2: Connect Client

### Obsidian Plugin

1. Settings → Community Plugins → Browse
2. Search "VaultLink", install, enable
3. Configure:
    - Server URL: `ws://localhost:3000` (or `wss://your-server.com` for SSL)
    - Token: Your token from config.yml
    - Vault Name: `default`

[Full plugin guide →](/guide/obsidian-plugin)

### CLI Client

```bash
docker run -d \
  --name vaultlink-cli \
  --restart unless-stopped \
  -v /path/to/vault:/vault \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault -r ws://localhost:3000 -t your-token -v default
```

[Full CLI guide →](/guide/cli-client)

## Production Setup

For production:

1. **SSL/TLS**: Use Nginx/Caddy reverse proxy for `wss://` ([setup guide](/guide/server-setup#ssl-tls-with-reverse-proxy))
2. **Secure tokens**: Generate with `openssl rand -hex 32`, don't reuse the example
3. **Firewall**: Only expose port 3000 to reverse proxy
4. **Backups**: SQLite databases are in `databases/` directory

## Multiple Users

```yaml
users:
    user_configs:
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
              type: allow_list
              allowed:
                  - shared
```

[Auth docs →](/config/authentication)

## Troubleshooting

**Server won't start**: `docker logs vaultlink-server`

**Client can't connect**:

1. Verify: `curl http://your-server:3000/vaults/test/ping`
2. Check URL: `ws://` for HTTP, `wss://` for HTTPS
3. Verify token matches config.yml

**Files not syncing**: Check client logs, verify vault name matches

[Server setup →](/guide/server-setup) | [Architecture →](/architecture/)
