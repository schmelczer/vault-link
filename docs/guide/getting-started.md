# Getting Started

Set up VaultLink in 5 minutes.

## Self-hosting the VaultLink server with docker-compose

todo: add compose file

Mount the configuration, databases, and (optionally) logs folder to your host:
- Configuration: the default path to it is. Mount the parent folder with something like:
```
- volumes:

```
and the configuration.yaml will be created on first startup. When a new config option is added to a future server version, the config.yml will be automatically updated. This also means that comments are not preserved inside the file but previously set values are.

 On first startup, an admin account is generated if no configuration.yaml exists or if the existing one contains no users. Changes made to the users section take into effect without requiring a server restart. This is controlled through the `hot-reload` flag within the `users` section.

- Databases: each vault is stored in its dedicated sqlite database located in the databases folder
- Logs: Logs are located at ... and are rotated every 7 days by default.

Add an expandable examplle <summary/>

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
You can generate secure token using: `openssl rand -hex 32`
:::

Run server:

```bash
docker run -d \
  --name vaultlink-server \
  --restart unless-stopped \
  -p 3000:3000 \
  -v $(pwd):/data \
  ghcr.io/schmelczer/vault-link-server:latest \
  /app/sync_server
```


Verify: `curl http://localhost:3000/vaults/test/ping` should return server version and auth status and http://localhost:3000 should show a version of this documentation bundled with the server's version.

::: warning
The server doesn't terminate HTTPS connections and is thus recommended to deploy behind a reverse proxy such as [NGINX] or [Caddy].
:::

::: tip
The server uses a local sqlite database to track documents within a Vault as opposed to plain text files. This is necessary so that the full provenance (history) of every document can be retrieved and it also prevents corruption of the server's state coming from outside changes to these files. In case you'd like to keep the latest version of a Vault's files on the server, you can deploy the [CLI client][#cli].
:::



In case of failures, check the logs on stdout or historical logs in the logs folder.

[Full server guide →](/guide/obsidian-plugin)


## Connecting to a VaultLink server using the VaultLink Obsidian plugin

1. Settings → Community Plugins → Browse
2. Search "VaultLink", install, enable
3. Then, update the sync settings within the VaultLink options:
    - Server URL: `http://localhost:3000` (or `https://your-server.com` for SSL)
    - Token: Your token from config.yml
    - Vault Name: Pick any name the token has access to, such as `default`. Users may be allowed to access a predefined list of vaults or every vault managed by the server. See [authorization](#auth) for more on this.

In case of failures, check the state summary (todo screenshot) or the logs tab available through the follow button from the settings tab (todo screenshot).

[Full plugin guide →](/guide/obsidian-plugin)


## CLI Client

```bash
docker run -d \
  --name vaultlink-cli \
  --restart unless-stopped \
  -v /path/to/vault:/vault \
  ghcr.io/schmelczer/vault-link-cli:latest \
  -l /vault -r ws://localhost:3000 -t your-token -v default
```

[Full CLI guide →](/guide/cli-client)


