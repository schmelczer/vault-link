use crate::app_state::database::models::VaultId;
use crate::utils::dedup_paths::dedup_paths;
use anyhow::{Result, bail};
use log::info;
use sqlx::sqlite::SqliteConnection;

const MAX_DEDUP_ATTEMPTS: usize = 100_000;

pub async fn find_first_available_path(
    vault_id: &VaultId,
    sanitized_relative_path: &str,
    database: &crate::app_state::database::Database,
    connection: &mut SqliteConnection,
) -> Result<String> {
    for (attempt, candidate) in dedup_paths(sanitized_relative_path).enumerate() {
        if attempt >= MAX_DEDUP_ATTEMPTS {
            bail!(
                "Could not find an available path after {MAX_DEDUP_ATTEMPTS} attempts for `{sanitized_relative_path}` in vault `{vault_id}`"
            );
        }

        if database
            .get_latest_non_deleted_document_by_path(vault_id, &candidate, Some(connection))
            .await?
            .is_none()
        {
            info!("Selected available path: `{candidate}`");
            return Ok(candidate);
        }

        info!(
            "Finding first available path for `{sanitized_relative_path}` in vault `{vault_id}` as `{candidate}` is already taken"
        );
    }

    bail!("dedup_paths iterator unexpectedly exhausted");
}
