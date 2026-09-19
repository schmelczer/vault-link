use super::{Database, Transaction, models::*};
use anyhow::Result;

impl Database {
    pub async fn allocate_event(
        tx: &mut Transaction<'_>,
        request_id: uuid::Uuid,
        fingerprint: &[u8],
    ) -> Result<VaultUpdateId> {
        Ok(sqlx::query(
            "INSERT INTO events(request_id, request_fingerprint, event_json) VALUES (?, ?, '')",
        )
        .bind(request_id.to_string())
        .bind(fingerprint)
        .execute(&mut **tx)
        .await?
        .last_insert_rowid())
    }

    pub async fn insert_document_version(
        tx: &mut Transaction<'_>,
        version: &StoredDocumentVersion,
    ) -> Result<()> {
        sqlx::query("INSERT INTO documents(vault_update_id, document_id, updated_date, content, user_id, device_id) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(version.vault_update_id)
            .bind(version.document_id.hyphenated())
            .bind(version.updated_date)
            .bind(&version.content)
            .bind(&version.user_id)
            .bind(&version.device_id)
            .execute(&mut **tx)
            .await?;

        Ok(())
    }

    pub async fn insert_file_manifest(
        tx: &mut Transaction<'_>,
        file_manifest: &FileManifest,
    ) -> Result<()> {
        sqlx::query("INSERT INTO file_manifests(file_manifest_id) VALUES (?)")
            .bind(file_manifest.file_manifest_id)
            .execute(&mut **tx)
            .await?;

        for (document_id, path) in &file_manifest.entries {
            sqlx::query(
                "INSERT INTO file_manifest_entries(file_manifest_id, document_id, path) VALUES (?, ?, ?)",
            )
            .bind(file_manifest.file_manifest_id)
            .bind(document_id.hyphenated())
            .bind(path)
            .execute(&mut **tx)
            .await?;
        }

        Ok(())
    }

    pub async fn write_event(tx: &mut Transaction<'_>, event: &EventRecord) -> Result<()> {
        sqlx::query("UPDATE events SET event_json = ? WHERE event_id = ?")
            .bind(serde_json::to_string(event)?)
            .bind(event.event_id)
            .execute(&mut **tx)
            .await?;
        Ok(())
    }
}
