ALTER TABLE documents ADD COLUMN creation_vault_update_id INTEGER NOT NULL DEFAULT 0;

UPDATE documents
SET creation_vault_update_id = (
    SELECT MIN(d2.vault_update_id)
    FROM documents d2
    WHERE d2.document_id = documents.document_id
);

DROP VIEW latest_document_versions;

CREATE VIEW IF NOT EXISTS latest_document_versions AS --recreate view as it now includes one more field
SELECT d.*
FROM documents d
INNER JOIN (
    SELECT MAX(vault_update_id) AS max_version_id
    FROM documents
    GROUP BY document_id
) max_versions
ON d.vault_update_id = max_versions.max_version_id;
