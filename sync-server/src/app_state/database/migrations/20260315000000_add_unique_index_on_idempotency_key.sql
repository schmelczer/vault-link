CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_idempotency_key
ON documents (idempotency_key) WHERE idempotency_key IS NOT NULL AND is_deleted = 0;
