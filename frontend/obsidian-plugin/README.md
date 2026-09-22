# VaultLink Obsidian plugin

Syncs an Obsidian vault with the VaultLink server, including active editor text,
selections, remote cursors, history and connection status. Use an API v5 server.
The vault configuration directory, Git metadata and trash are ignored by default.

From `frontend`:

```sh
npm run build -w sync-client -w vault-link-obsidian-plugin
npm run test -w vault-link-obsidian-plugin
```

The production bundle is in `obsidian-plugin/dist`: `main.js`, `manifest.json`
and `styles.css`. Copy those files into the vault's plugin directory to install.

Desktop Obsidian shares the CLI's Node filesystem and atomic metadata adapters.
The complete client record remains in the plugin's `data.json`; it includes
settings, sync state, queued logical notifications and the server history
checkpoint. Mobile uses Obsidian's storage and plugin data APIs. Because mobile
writes overwrite existing files, exclusive creation uses a disposable input for
`DataAdapter.copy` in `.vault-link-sync`. This is not a filesystem journal or a
recovery payload.

Raw create/modify/delete events wake a fresh scan, including events caused by
sync and editor replacements. Obsidian's logical rename event preserves file
and directory move identities. Editor snapshots include unsaved text and
selections; content application updates both disk and the active editor.

Adapter tests cover unsaved text, cursor restoration, exclusive creation and
storage failures. The repository E2E runner builds the plugin and tests its
filesystem adapter against the server alongside real CLI processes. These tests
do not launch Obsidian itself.
