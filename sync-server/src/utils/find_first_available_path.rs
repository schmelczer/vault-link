use crate::app_state::database::models::VaultId;
use crate::utils::dedup_paths::dedup_paths;
use anyhow::Result;
use log::{debug, info};
use sqlx::sqlite::SqliteConnection;


pub async fn find_first_available_path(
    vault_id: &VaultId,
    sanitized_relative_path: &str,
    database: &crate::app_state::database::Database,
    connection: &mut SqliteConnection,
) -> Result<String> {
    info!("Finding first available path for `{sanitized_relative_path}` in vault `{vault_id}`");
    for candidate in dedup_paths(sanitized_relative_path) {
        debug!("Checking candidate path for deconflicting names: `{candidate}`");
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

    unreachable!("dedup_paths produces infinite paths");
}
