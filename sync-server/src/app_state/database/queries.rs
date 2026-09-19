use super::{
    Database, Transaction,
    models::{
        DocumentId, DocumentVersionWithoutContent, EventBatch, EventRecord, FileManifest,
        StoredDocumentVersion, VaultEvent, VaultId, VaultSnapshot, VaultUpdateId,
    },
};
use anyhow::{Context as _, Result, ensure};

impl Database {
    pub async fn get_request_event(
        tx: &mut Transaction<'_>,
        request_id: uuid::Uuid,
    ) -> Result<Option<(Vec<u8>, VaultEvent)>> {
        let row: Option<(Vec<u8>, VaultUpdateId)> =
            sqlx::query_as("SELECT request_fingerprint, event_id FROM events WHERE request_id = ?")
                .bind(request_id.to_string())
                .fetch_optional(&mut **tx)
                .await?;
        match row {
            Some((fingerprint, event_id)) => {
                Ok(Some((fingerprint, Self::event_by_id(tx, event_id).await?)))
            }
            None => Ok(None),
        }
    }

    pub async fn get_latest_document_version(
        &self,
        vault: &VaultId,
        id: &DocumentId,
        transaction: Option<&mut Transaction<'_>>,
    ) -> Result<Option<StoredDocumentVersion>> {
        let query = sqlx::query_as::<_, StoredDocumentVersion>(
            "SELECT * FROM documents WHERE document_id = ? ORDER BY vault_update_id DESC LIMIT 1",
        )
        .bind(id.hyphenated());

        Ok(if let Some(tx) = transaction {
            query.fetch_optional(&mut **tx).await?
        } else {
            query
                .fetch_optional(&self.get_connection_pool(vault).await?)
                .await?
        })
    }

    pub async fn get_document_version(
        &self,
        vault: &VaultId,
        version: VaultUpdateId,
        transaction: Option<&mut Transaction<'_>>,
    ) -> Result<Option<StoredDocumentVersion>> {
        let query = sqlx::query_as::<_, StoredDocumentVersion>(
            "SELECT * FROM documents WHERE vault_update_id = ?",
        )
        .bind(version);

        Ok(if let Some(tx) = transaction {
            query.fetch_optional(&mut **tx).await?
        } else {
            query
                .fetch_optional(&self.get_connection_pool(vault).await?)
                .await?
        })
    }

    pub async fn current_file_manifest(tx: &mut Transaction<'_>) -> Result<FileManifest> {
        let Some(file_manifest_id) = sqlx::query_scalar::<_, VaultUpdateId>(
            "SELECT file_manifest_id FROM file_manifests ORDER BY file_manifest_id DESC LIMIT 1",
        )
        .fetch_optional(&mut **tx)
        .await?
        else {
            return Ok(FileManifest::default());
        };

        Self::file_manifest_by_id(tx, file_manifest_id)
            .await?
            .context("Latest file manifest is missing")
    }

    async fn file_manifest_by_id(
        tx: &mut Transaction<'_>,
        file_manifest_id: VaultUpdateId,
    ) -> Result<Option<FileManifest>> {
        let exists = sqlx::query_scalar::<_, VaultUpdateId>(
            "SELECT file_manifest_id FROM file_manifests WHERE file_manifest_id = ?",
        )
        .bind(file_manifest_id)
        .fetch_optional(&mut **tx)
        .await?;
        if exists.is_none() {
            return Ok(None);
        }
        let entries = sqlx::query_as::<_, (uuid::fmt::Hyphenated, String)>(
            "SELECT document_id, path FROM file_manifest_entries WHERE file_manifest_id = ?",
        )
        .bind(file_manifest_id)
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .map(|(document_id, path)| (document_id.into_uuid(), path))
        .collect();

        Ok(Some(FileManifest {
            file_manifest_id,
            entries,
        }))
    }

    async fn event_by_id(tx: &mut Transaction<'_>, event_id: VaultUpdateId) -> Result<VaultEvent> {
        let document = sqlx::query_as::<_, DocumentVersionWithoutContent>(
            "SELECT vault_update_id, document_id, updated_date, user_id, device_id,
                    length(content) AS content_size
             FROM documents WHERE vault_update_id = ?",
        )
        .bind(event_id)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(document) = document {
            return Ok(VaultEvent::Content { document });
        }
        let file_manifest = Self::file_manifest_by_id(tx, event_id)
            .await?
            .context("Event has no normalized content or file manifest")?;
        Ok(VaultEvent::FileManifest { file_manifest })
    }

    pub async fn latest_event_id(tx: &mut Transaction<'_>) -> Result<VaultUpdateId> {
        Ok(
            sqlx::query_scalar("SELECT COALESCE(MAX(event_id), 0) FROM events")
                .fetch_one(&mut **tx)
                .await?,
        )
    }

    pub async fn vault_snapshot(&self, vault: &VaultId) -> Result<VaultSnapshot> {
        let mut tx = self.create_readonly_transaction(vault).await?;
        let head_event_id = Self::latest_event_id(&mut tx).await?;
        let file_manifest = Self::current_file_manifest(&mut tx).await?;

        let documents = sqlx::query_as::<_, DocumentVersionWithoutContent>(
            "SELECT d.vault_update_id, d.document_id, d.updated_date, d.user_id, d.device_id,
                    length(d.content) AS content_size
             FROM latest_document_versions d
             JOIN file_manifest_entries m ON m.document_id = d.document_id
             WHERE m.file_manifest_id = ? ORDER BY d.vault_update_id",
        )
        .bind(file_manifest.file_manifest_id)
        .fetch_all(&mut *tx)
        .await?;

        Ok(VaultSnapshot {
            head_event_id,
            file_manifest,
            documents,
        })
    }

    pub async fn events_after(&self, vault: &VaultId, after: VaultUpdateId) -> Result<EventBatch> {
        let mut tx = self.create_readonly_transaction(vault).await?;
        let head_event_id = Self::latest_event_id(&mut tx).await?;

        ensure!(
            (0..=head_event_id).contains(&after),
            "Event cursor is outside this vault's history"
        );

        let rows: Vec<(VaultUpdateId, String)> = sqlx::query_as(
            "SELECT event_id, request_id FROM events WHERE event_id > ? ORDER BY event_id",
        )
        .bind(after)
        .fetch_all(&mut *tx)
        .await?;

        let mut events = Vec::with_capacity(rows.len());
        for (event_id, request_id) in rows {
            events.push(EventRecord {
                event_id,
                request_id: request_id.parse()?,
                event: Self::event_by_id(&mut tx, event_id).await?,
            });
        }

        Ok(EventBatch {
            head_event_id,
            events,
        })
    }
}
