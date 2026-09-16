use anyhow::{Context as _, Result};
use sqlx::types::chrono::Utc;
use uuid::fmt::Hyphenated;

use super::models::{StoredDocumentVersion, VaultId, VaultUpdateId};
use super::{Database, Transaction};

impl Database {
    pub async fn get_document_version(
        &self,
        vault: &VaultId,
        vault_update_id: VaultUpdateId,
        transaction: Option<&mut Transaction<'_>>,
    ) -> Result<Option<StoredDocumentVersion>> {
        let query = sqlx::query_as!(
            StoredDocumentVersion,
            r#"
            select
                vault_update_id,
                document_id as "document_id: Hyphenated",
                relative_path,
                updated_date as "updated_date: chrono::DateTime<Utc>",
                content,
                is_deleted,
                user_id,
                device_id
            from documents
            where vault_update_id = ?"#,
            vault_update_id
        );

        if let Some(transaction) = transaction {
            query.fetch_optional(&mut **transaction).await
        } else {
            query
                .fetch_optional(&self.get_connection_pool(vault).await?)
                .await
        }
        .context("Cannot fetch document version")
    }
}
