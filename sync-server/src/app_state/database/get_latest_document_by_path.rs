use anyhow::{Context as _, Result};
use sqlx::types::chrono::Utc;
use uuid::fmt::Hyphenated;

use super::models::{StoredDocumentVersion, VaultId};
use super::{Database, Transaction};

impl Database {
    pub async fn get_latest_document_by_path(
        &self,
        vault: &VaultId,
        relative_path: &str,
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
            from latest_document_versions
            where relative_path = ? and is_deleted = false
            order by vault_update_id desc  -- `latest_document_versions` only contains a single latest version of each document, however,
                                            -- multiple documents can have the same `relative_path`, if they have been deleted. That's
                                            -- why we only care about the latest version of the document with the given relative path.
            limit 1
            "#,
            relative_path
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
