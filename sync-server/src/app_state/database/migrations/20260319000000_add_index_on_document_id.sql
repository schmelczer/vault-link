CREATE INDEX IF NOT EXISTS idx_documents_document_id
ON documents (document_id, vault_update_id);
