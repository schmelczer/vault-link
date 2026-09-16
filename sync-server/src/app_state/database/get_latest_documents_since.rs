use anyhow::{Context as _, Result};
use sqlx::types::chrono::Utc;
use uuid::fmt::Hyphenated;

use super::models::{DocumentVersionWithoutContent, VaultId, VaultUpdateId};
use super::{Database, Transaction};

impl Database {
    /// Return the latest state of all documents (including deleted) in the
    /// vault which have changed since the given update id
    pub async fn get_latest_documents_since(
        &self,
        vault: &VaultId,
        vault_update_id: VaultUpdateId,
        transaction: Option<&mut Transaction<'_>>,
    ) -> Result<Vec<DocumentVersionWithoutContent>> {
        let query = sqlx::query!(
            r#"
            select
                vault_update_id,
                document_id as "document_id: Hyphenated",
                relative_path,
                updated_date as "updated_date: chrono::DateTime<Utc>",
                is_deleted,
                user_id,
                device_id,
                length(content) as "content_size: u64"
            from latest_document_versions
            where vault_update_id > ?
            order by vault_update_id
            "#,
            vault_update_id
        );

        if let Some(transaction) = transaction {
            query.fetch_all(&mut **transaction).await
        } else {
            query
                .fetch_all(&self.get_connection_pool(vault).await?)
                .await
        }
        .with_context(|| {
            format!("Cannot fetch latest documents since vault_update_id `{vault_update_id}`")
        })
        .map(|rows| {
            rows.into_iter()
                .map(|row| DocumentVersionWithoutContent {
                    vault_update_id: row.vault_update_id,
                    document_id: row.document_id.into(),
                    relative_path: row.relative_path,
                    updated_date: row.updated_date,
                    is_deleted: row.is_deleted,
                    user_id: row.user_id,
                    device_id: row.device_id,
                    content_size: row
                        .content_size
                        .expect("Content size can't be null but sqlx can't infer it"),
                })
                .collect()
        })
    }
}
