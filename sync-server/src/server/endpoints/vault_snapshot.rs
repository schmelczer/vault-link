use axum::{
    Json,
    extract::{Path, State},
};
use log::debug;

use super::VaultPath;
use crate::{
    app_state::{AppState, database::models::VaultSnapshot},
    errors::{SyncServerError, server_error},
};

#[axum::debug_handler]
pub async fn vault_snapshot(
    Path(VaultPath(vault_id)): Path<VaultPath>,
    State(state): State<AppState>,
) -> Result<Json<VaultSnapshot>, SyncServerError> {
    debug!("Fetching vault snapshot for vault `{vault_id}`");

    state
        .database
        .vault_snapshot(&vault_id)
        .await
        .map(Json)
        .map_err(server_error)
}
