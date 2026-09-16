# Sync server

## Document pushes (API v3)

The server stores immutable document versions. One compare-and-swap endpoint,
`PUT /vaults/:vault_id/documents/:document_id`, handles every mutation. The client
generates the document UUID; the JSON body contains:

- `requestId`: a UUID identifying this exact push.
- `parentVersionId`: `null` to create an absent document, otherwise its base version.
- `relativePath`: the desired filename.
- `content`: `{ "type": "Snapshot", "value": "<base64>" }`,
  `{ "type": "Diff", "value": [3, "inserted text", -2] }`, or `{ "type": "Delete" }`.

All pushes return one of:

- `Accepted`: version metadata for the exact snapshot committed. A retry with the
  same request ID returns the original acknowledgement, even after a restart or
  subsequent updates. Clients must persist the ID with the unchanged request.
  A payload fingerprint rejects reusing that ID for a different mutation.
- `StaleBase`: the current version, including `contentBase64`. Nothing was written;
  the client merges locally and submits a new push with a new request ID.

The base check, path allocation, new version, and durable acknowledgement share
one SQLite write transaction. A deleted document stays deleted; recreating a file
uses a new document ID. Occupied paths receive an available numbered filename.
Text updates accept reconcile-text transport diffs against the base version;
the server only reconstructs snapshots and never merges concurrent edits.

Snapshot requests use base64, adding roughly one third to the raw file size.
Server and reverse-proxy request limits apply to the encoded JSON body.

API v3 uses a fresh schema. Update clients together with the server and initialise
new vault databases; compatibility with previous releases is not supported.

## Creating/resetting the Database for development

```sh
rm -rf db.sqlite*
sqlx database create --database-url sqlite://db.sqlite3
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
cargo sqlx prepare --workspace
```

## Updating the DB schema through a migration

```sh
sqlx migrate add --source src/app_state/database/migrations <name>
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
```
