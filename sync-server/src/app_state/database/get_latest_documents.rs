use anyhow::{Context as _, Result};
use sqlx::types::chrono::Utc;
use uuid::fmt::Hyphenated;

use super::models::{DocumentVersionWithoutContent, VaultId};
use super::{Database, Transaction};

impl Database {
    /// Return the latest state of all documents in the vault
    pub async fn get_latest_documents(
        &self,
        vault: &VaultId,
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
            order by vault_update_id
            "#,
        );

        if let Some(transaction) = transaction {
            query.fetch_all(&mut **transaction).await
        } else {
            query
                .fetch_all(&self.get_connection_pool(vault).await?)
                .await
        }
        .context("Cannot fetch latest documents")
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
