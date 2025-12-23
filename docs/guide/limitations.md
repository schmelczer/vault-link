# Limitations

VaultLink works well for most Obsidian vaults, but has some constraints you should know about.


## No end-to-end encryption (E2EE)

VaultLink is meant to be self-hosted, so trust towards the server is expected. This is why E2EE isn't a must-have feature. Additionally, the server needs to be able to read the user's file's content in order to merge it. The [sync algorithm](./sync) doesn't support homomorphic operations and thus must operate on clear text.   


## File Type Limitations


By default, only **`.md`** and **`.txt`** files get automatic conflict-free merging. This can be extended thorugh the `server.mergeable_file_extensions` config to text files with arbitrary file extensions. However, changes to binary files can't be merged automatically. To be fair, they shouldn't be, as without knowing the structure of the binary, the merging algorithm would just corrupt the file.

So in case of bianry file types (images, PDFs, etc.) use last-write-wins:

```
User A updates diagram.png → Server stores version 1
User B updates diagram.png → Server stores version 2 (overwrites A's changes)
```

### Binary Detection

Files are treated as binary if any of the following is true:

- Their file extension isn't incldued in the `server.mergeable_file_extensions` list (matching is case-insensitive)
- Contain NUL bytes (`0x00`)
- Fail UTF-8 validation
