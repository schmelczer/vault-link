use anyhow::{Context as _, Result};
use sqlx::types::chrono::Utc;
use uuid::fmt::Hyphenated;

use super::models::{DocumentId, StoredDocumentVersion, VaultId};
use super::{Database, Transaction};

impl Database {
    pub async fn get_latest_document(
        &self,
        vault: &VaultId,
        document_id: &DocumentId,
        transaction: Option<&mut Transaction<'_>>,
    ) -> Result<Option<StoredDocumentVersion>> {
        let document_id = document_id.as_hyphenated();
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
            from latest_document_versions
            where document_id = ?
            "#,
            document_id
        );

        if let Some(transaction) = transaction {
            query.fetch_optional(&mut **transaction).await
        } else {
            query
                .fetch_optional(&self.get_connection_pool(vault).await?)
                .await
        }
        .context("Cannot fetch latest document version")
    }
}
