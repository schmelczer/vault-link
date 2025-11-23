use crate::app_state::database::models::VaultId;
use crate::{app_state::database::Transaction, utils::dedup_paths::dedup_paths};
use anyhow::Result;

pub async fn find_first_available_path(
    vault_id: &VaultId,
    sanitized_relative_path: &str,
    database: &crate::app_state::database::Database,
    transaction: &mut Transaction<'_>,
) -> Result<String> {
    let mut new_relative_path = String::default();
    for candidate in dedup_paths(sanitized_relative_path) {
        if database
            .get_latest_document_by_path(vault_id, &candidate, Some(transaction))
            .await?
            .is_none()
        {
            new_relative_path = candidate;
            break;
        }
    }

    Ok(new_relative_path)
}
