use axum::{
    Json,
    extract::{Path, State},
};
use log::debug;
use serde::Deserialize;

use crate::{
    app_state::{
        AppState,
        database::models::{VaultId, VaultSnapshot},
    },
    errors::{SyncServerError, server_error},
    utils::normalize_vault_id::normalize_vault_id,
};

#[derive(Deserialize)]
pub struct VaultSnapshotPath {
    #[serde(deserialize_with = "normalize_vault_id")]
    vault_id: VaultId,
}

#[axum::debug_handler]
pub async fn vault_snapshot(
    Path(path): Path<VaultSnapshotPath>,
    State(state): State<AppState>,
) -> Result<Json<VaultSnapshot>, SyncServerError> {
    debug!("Fetching vault snapshot for vault `{}`", path.vault_id);

    state
        .database
        .vault_snapshot(&path.vault_id)
        .await
        .map(Json)
        .map_err(server_error)
}
