# Getting Started

This guide will walk you through setting up VaultLink from scratch. You'll have a working sync server and connected client in under 10 minutes.

## Prerequisites

- Docker installed (recommended) or Rust toolchain for building from source
- Basic familiarity with command line
- A server or machine to host the sync server (can be localhost for testing)

## Quick Start

### Step 1: Deploy the Sync Server

The fastest way to get started is with Docker:

```bash
# Create a directory for server data
mkdir -p ~/vaultlink-data
cd ~/vaultlink-data

# Create a basic configuration file
cat > config.yml << 'EOF'
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
    token: change-this-to-a-secure-random-token
    vault_access:
      type: allow_access_to_all
logging:
  log_directory: logs
  log_rotation: 7days
EOF

# Run the server
docker run -d \
  --name vaultlink-server \
  --restart unless-stopped \
  -p 3000:3000 \
  -v $(pwd):/data \
  ghcr.io/schmelczer/vault-link-server:latest \
  /app/sync_server /data/config.yml
```

::: warning
Change the token in `config.yml` to a secure random value before deploying to production!
:::

Verify the server is running:

```bash
curl http://localhost:3000/vaults/test/ping
```

You should see: `pong`

### Step 2: Choose Your Client

You can connect to VaultLink using either the Obsidian plugin or the standalone CLI client.

#### Option A: Obsidian Plugin

1. Open Obsidian Settings → Community Plugins
2. Browse community plugins and search for "VaultLink"
3. Install and enable the plugin
4. Configure the plugin:
   - **Server URL**: `ws://localhost:3000` (or your server address)
   - **Token**: The token from your `config.yml`
   - **Vault Name**: `default` (or any name you choose)

[Read the full Obsidian plugin guide →](/guide/obsidian-plugin)

#### Option B: CLI Client

Perfect for syncing vaults without Obsidian:

```bash
docker run -d \
  --name vaultlink-cli \
  --restart unless-stopped \
  -v /path/to/your/vault:/vault \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault \
  -r ws://localhost:3000 \
  -t change-this-to-a-secure-random-token \
  -v default
```

Replace `/path/to/your/vault` with the directory containing your files.

[Read the full CLI client guide →](/guide/cli-client)

## Next Steps

### Production Deployment

For production use, you should:

1. **Use HTTPS/WSS**: Put the sync server behind a reverse proxy with SSL
2. **Secure tokens**: Generate cryptographically random tokens
3. **Configure backups**: Back up the SQLite databases regularly
4. **Set up monitoring**: Use Docker health checks and logging

[Learn about production deployment →](/guide/server-setup#production-deployment)

### Multiple Users

To add more users or restrict vault access:

```yaml
users:
  user_configs:
  - name: alice
    token: alice-secure-token
    vault_access:
      type: allow_list
      allowed:
        - personal
        - shared
  - name: bob
    token: bob-secure-token
    vault_access:
      type: allow_list
      allowed:
        - shared
```

[Learn about authentication configuration →](/config/authentication)

### Advanced Configuration

Explore advanced server options:

- Database tuning for large vaults
- Rate limiting and connection limits
- Custom logging and log rotation
- Multi-vault setups

[View configuration reference →](/config/server)

## Architecture Overview

Want to understand how VaultLink works under the hood?

[Read the architecture documentation →](/architecture/)

## Troubleshooting

### Server won't start

Check Docker logs:
```bash
docker logs vaultlink-server
```

Common issues:
- Port 3000 already in use: Change the port mapping `-p 3001:3000`
- Config file errors: Validate YAML syntax
- Permission issues: Ensure the volume mount is writable

### Client can't connect

1. Verify server is accessible: `curl http://your-server:3000/vaults/test/ping`
2. Check WebSocket connectivity (browser dev tools or wscat)
3. Verify token matches between client and server config
4. Check firewall rules allow port 3000

### Files not syncing

1. Check client logs for errors
2. Verify vault name matches on both server and client
3. Ensure user has access to the vault (check server config)
4. Check for file size limits (default 10MB for CLI)

For more help, [open an issue on GitHub](https://github.com/schmelczer/vault-link/issues).
