use anyhow::{Context as _, Result};

use super::models::VaultId;
use super::{Database, Transaction};

impl Database {
    pub async fn get_max_update_id_in_vault(
        &self,
        vault: &VaultId,
        transaction: Option<&mut Transaction<'_>>,
    ) -> Result<i64> {
        let query = sqlx::query!(
            r#"
            select coalesce(max(vault_update_id), 0) as max_vault_update_id
            from documents
            "#,
        );

        if let Some(transaction) = transaction {
            query.fetch_one(&mut **transaction).await
        } else {
            query
                .fetch_one(&self.get_connection_pool(vault).await?)
                .await
        }
        .map(|row| row.max_vault_update_id)
        .context("Cannot fetch max update id in vault")
    }
}
