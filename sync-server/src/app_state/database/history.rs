//! Checkpoints distinguish restored histories even when numeric event IDs are reused.
use super::Database;
use super::models::VaultId;
use anyhow::Result;

const EMPTY_HISTORY_CHECKPOINT: &str = "0:empty";

impl Database {
    pub async fn get_history_checkpoint(&self, vault: &VaultId) -> Result<String> {
        let mut tx = self.create_readonly_transaction(vault).await?;

        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT event_id, event_token FROM events ORDER BY event_id DESC LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;

        Ok(row.map_or_else(
            || EMPTY_HISTORY_CHECKPOINT.to_owned(),
            |(id, token)| format!("{id}:{token}"),
        ))
    }

    pub async fn contains_checkpoint(&self, vault: &VaultId, checkpoint: &str) -> Result<bool> {
        if checkpoint == EMPTY_HISTORY_CHECKPOINT {
            return Ok(true);
        }

        let Some((id, token)) = checkpoint.split_once(':') else {
            return Ok(false);
        };

        let Ok(id) = id.parse::<i64>() else {
            return Ok(false);
        };

        let mut tx = self.create_readonly_transaction(vault).await?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM events WHERE event_id = ? AND event_token = ?)",
        )
        .bind(id)
        .bind(token)
        .fetch_one(&mut *tx)
        .await?;

        Ok(exists)
    }
}
