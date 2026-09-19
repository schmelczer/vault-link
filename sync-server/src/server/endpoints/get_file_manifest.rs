use axum::{
    Json,
    extract::{Path, State},
};
use log::debug;
use serde::Deserialize;

use crate::{
    app_state::{
        AppState,
        database::{
            Database,
            models::{FileManifest, VaultId},
        },
    },
    errors::{SyncServerError, server_error},
    utils::normalize_vault_id::normalize_vault_id,
};

#[derive(Deserialize)]
pub struct GetFileManifestPath {
    #[serde(deserialize_with = "normalize_vault_id")]
    vault_id: VaultId,
}

#[axum::debug_handler]
pub async fn get_file_manifest(
    Path(path): Path<GetFileManifestPath>,
    State(state): State<AppState>,
) -> Result<Json<FileManifest>, SyncServerError> {
    debug!("Fetching file manifest for vault `{}`", path.vault_id);

    let mut transaction = state
        .database
        .create_readonly_transaction(&path.vault_id)
        .await
        .map_err(server_error)?;

    Database::current_file_manifest(&mut transaction)
        .await
        .map(Json)
        .map_err(server_error)
}
