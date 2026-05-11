use crate::app_state::database::{WriteTransaction, models::VaultId};
use crate::errors::{SyncServerError, server_error};
use crate::utils::dedup_paths::dedup_paths;
use anyhow::anyhow;
use log::{debug, info};

pub async fn find_first_available_path(
    vault_id: &VaultId,
    sanitized_relative_path: &str,
    database: &crate::app_state::database::Database,
    transaction: &mut WriteTransaction,
) -> Result<String, SyncServerError> {
    info!("Finding first available path for `{sanitized_relative_path}` in vault `{vault_id}`");
    for candidate in dedup_paths(sanitized_relative_path) {
        debug!("Checking candidate path for deconflicting names: `{candidate}`");
        if database
            .get_latest_non_deleted_document_by_path(
                vault_id,
                &candidate,
                Some(transaction.connection_mut().map_err(server_error)?),
            )
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

    Err(server_error(anyhow!(
        "No available path candidates produced for `{sanitized_relative_path}` in vault `{vault_id}`"
    )))
}
