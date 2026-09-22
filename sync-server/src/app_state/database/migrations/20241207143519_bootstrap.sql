CREATE TABLE events (
    -- Numeric position in the vault's history: orders events, serves as
    -- vault_update_id/file_manifest_id, parent IDs, and page cursors
    event_id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(event_id <= 9007199254740991), -- JavaScript’s Number.MAX_SAFE_INTEGER
    -- Server-minted random identity of this event's incarnation, minted once
    -- per INSERT. Unlike request_id it is never reproduced by a resubmitted
    -- request, so the history checkpoint `event_id:event_token` fails whenever
    -- a restored backup reuses a numeric ID or a client resubmits the same
    -- request UUID against a different history
    event_token TEXT,
    -- Client-chosen idempotency key, stable across retries so the server can
    -- deduplicate a replayed request
    request_id TEXT NOT NULL UNIQUE,
    -- Hash of the request payload that carried this event
    request_fingerprint BLOB NOT NULL
);

CREATE TABLE documents (
    vault_update_id INTEGER PRIMARY KEY REFERENCES events(event_id),
    document_id TEXT NOT NULL,
    updated_date TEXT NOT NULL,
    content BLOB NOT NULL,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL
);

CREATE INDEX documents_by_id ON documents(document_id);

CREATE VIEW latest_document_versions AS
    SELECT d.* FROM documents d JOIN (
        SELECT document_id, MAX(vault_update_id) AS version FROM documents GROUP BY document_id
    ) heads ON d.vault_update_id = heads.version;

CREATE TABLE file_manifests (
    file_manifest_id INTEGER PRIMARY KEY REFERENCES events(event_id)
);

CREATE TABLE file_manifest_entries (
    file_manifest_id INTEGER NOT NULL REFERENCES file_manifests(file_manifest_id),
    document_id TEXT NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (file_manifest_id, document_id),
    UNIQUE (file_manifest_id, path)
);
