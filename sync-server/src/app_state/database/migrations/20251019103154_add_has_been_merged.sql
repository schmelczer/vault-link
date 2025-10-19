ALTER TABLE documents ADD COLUMN has_been_merged BOOLEAN NOT NULL DEFAULT False;

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
