use axum::{
    Json,
    extract::{Path, State},
};
use log::debug;

use super::VaultPath;
use crate::{
    app_state::{
        AppState,
        database::{Database, models::FileManifest},
    },
    errors::{SyncServerError, server_error},
};

#[axum::debug_handler]
pub async fn get_file_manifest(
    Path(VaultPath(vault_id)): Path<VaultPath>,
    State(state): State<AppState>,
) -> Result<Json<FileManifest>, SyncServerError> {
    debug!("Fetching file manifest for vault `{vault_id}`");

    let mut transaction = state
        .database
        .create_readonly_transaction(&vault_id)
        .await
        .map_err(server_error)?;

    Database::current_file_manifest(&mut transaction)
        .await
        .map(Json)
        .map_err(server_error)
}
