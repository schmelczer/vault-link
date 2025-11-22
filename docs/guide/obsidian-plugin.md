# Obsidian Plugin

The VaultLink Obsidian plugin provides native real-time synchronization directly within Obsidian.

## Installation

### From Obsidian Community Plugins

1. Open Obsidian Settings
2. Navigate to **Community Plugins**
3. Click **Browse** and search for "VaultLink"
4. Click **Install**
5. Enable the plugin

### Manual Installation

1. Download the latest release from [GitHub Releases](https://github.com/schmelczer/vault-link/releases)
2. Extract `main.js`, `manifest.json`, and `styles.css`
3. Copy to `.obsidian/plugins/vault-link/` in your vault
4. Reload Obsidian
5. Enable VaultLink in Community Plugins settings

## Configuration

After installation, configure the plugin in **Settings → VaultLink**.

### Required Settings

#### Server URL
The WebSocket URL of your sync server.

- **Development/Local**: `ws://localhost:3000`
- **Production (SSL)**: `wss://sync.example.com`

::: tip
Use `ws://` for unencrypted connections and `wss://` for SSL connections (production).
:::

#### Authentication Token
Your authentication token from the server's `config.yml`.

Generate a secure token:
```bash
openssl rand -hex 32
```

#### Vault Name
The name of the vault on the server. Can be any string.

Multiple Obsidian vaults can sync to the same server vault name (for shared vaults), or use unique names for separate vaults.

### Optional Settings

#### Sync Concurrency
Number of files to sync simultaneously.
- **Default**: 1
- **Range**: 1-10
- Higher values = faster initial sync, more resource usage

#### Max File Size
Maximum file size to sync (in MB).
- **Default**: 10
- Files larger than this are skipped

#### Ignore Patterns
Glob patterns for files to exclude from sync.

Examples:
- `*.tmp` - Ignore temporary files
- `.trash/**` - Ignore trash folder
- `private/**` - Ignore private directory

#### WebSocket Retry Interval
Milliseconds between reconnection attempts when disconnected.
- **Default**: 3500ms
- Increase for flaky networks to avoid connection spam

## Usage

### Initial Sync

When first connecting:

1. The plugin uploads all local files to the server
2. Downloads any missing files from the server
3. Resolves any conflicts using operational transformation
4. Begins real-time synchronization

Initial sync time depends on vault size and `sync_concurrency` setting.

### Real-Time Sync

Once connected:

- **File changes**: Automatically synced when saved
- **File creation**: New files immediately uploaded
- **File deletion**: Deletions propagated to other clients
- **File renames**: Tracked and synchronized

The plugin watches your vault filesystem and syncs changes in real-time via WebSocket.

### Status Indicators

The plugin provides visual feedback:

- **Connected**: Green status in settings
- **Syncing**: Progress indicator during uploads
- **Disconnected**: Red status, automatic reconnection attempts
- **Error**: Error message in settings and console

Check the Obsidian console (Ctrl+Shift+I / Cmd+Option+I) for detailed logs.

## Features

### Automatic Conflict Resolution

When multiple users edit the same file simultaneously, operational transformation merges changes automatically:

- All edits are preserved
- No manual conflict resolution required
- Changes appear in real-time as others type

### Mobile Support

VaultLink works on Obsidian mobile (iOS and Android):

- Same configuration as desktop
- Real-time sync across all devices
- Handle network changes gracefully

::: warning
Ensure your sync server is accessible from mobile networks (use WSS with a public domain or VPN).
:::

### Offline Support

The plugin handles offline scenarios:

- Continue working when disconnected
- Changes queue locally
- Automatic sync when connection restored
- Conflict resolution if others edited the same files

## Collaboration Workflows

### Personal Multi-Device Sync

Sync the same vault across devices:

1. Configure each Obsidian instance with the same vault name
2. Use the same authentication token
3. All devices stay in sync automatically

### Team Shared Vault

Multiple users collaborating:

1. Each user has their own token (configured in server `config.yml`)
2. All users connect to the same vault name
3. Real-time collaborative editing with automatic conflict resolution

### Selective Sharing

Share specific folders while keeping others private:

1. Use different vault names for shared vs. private content
2. Configure access control on the server per vault
3. Use ignore patterns to exclude sensitive directories

## Troubleshooting

### Plugin won't connect

1. **Verify server is running**:
   ```bash
   curl http://your-server:3000/vaults/test/ping
   ```
   Should return `pong`

2. **Check URL format**:
   - Local: `ws://localhost:3000`
   - Remote (SSL): `wss://sync.example.com`
   - Don't include `/vault/name` in the URL

3. **Verify token**:
   - Must match server config exactly
   - No extra spaces or quotes
   - Check server logs for authentication errors

4. **Check firewall**:
   - Ensure port is accessible from your network
   - For mobile, server must be publicly accessible or use VPN

### Files not syncing

1. **Check ignore patterns**: File may match an exclusion pattern
2. **File size**: Check if file exceeds `max_file_size_mb`
3. **Permissions**: Ensure vault directory is readable/writable
4. **Console errors**: Open dev tools (Ctrl+Shift+I) and check console

### Slow initial sync

1. **Increase concurrency**: Set `sync_concurrency` higher (e.g., 5)
2. **Network speed**: Check internet connection
3. **Server resources**: Ensure server isn't overloaded
4. **Large files**: Consider increasing timeout settings

### Conflicts not resolving

Operational transformation should handle conflicts automatically. If issues persist:

1. Check console for sync errors
2. Verify both clients are connected
3. Check server logs for processing errors
4. Ensure files are text-based (binary files may not merge well)

### High CPU/Memory usage

1. **Reduce concurrency**: Lower `sync_concurrency`
2. **Add ignore patterns**: Exclude unnecessary files
3. **File watchers**: Large vaults may trigger many filesystem events
4. **Check for sync loops**: Ensure no circular dependencies

## Advanced Configuration

### Multiple Vaults

To sync multiple Obsidian vaults to different server vaults:

1. Each Obsidian vault has its own VaultLink plugin configuration
2. Use different vault names for each
3. Can use the same or different tokens (depending on access control)

### Custom Sync Patterns

Combine ignore patterns for fine-grained control:

```
# Ignore patterns
*.tmp
*.bak
.DS_Store
.trash/**
private/**
drafts/**/*.draft.md
```

### Development/Testing

For plugin development:

1. Clone the repository
2. `cd frontend && npm install`
3. `npm run dev` to build in watch mode
4. Plugin rebuilds automatically on changes
5. Reload Obsidian to test changes

## Next Steps

- [Learn about the sync algorithm →](/architecture/sync-algorithm)
- [Configure the server →](/config/server)
- [Set up the CLI client →](/guide/cli-client)
