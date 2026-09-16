use axum::{
    Json,
    extract::{Path, State},
};
use log::debug;
use serde::Deserialize;

use crate::{
    app_state::{
        AppState,
        database::models::{DocumentVersionWithoutContent, VaultId},
    },
    errors::{SyncServerError, server_error},
    utils::normalize::normalize,
};

#[derive(Deserialize)]
pub struct FetchLatestDocumentsPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
}

#[axum::debug_handler]
pub async fn fetch_latest_documents(
    Path(FetchLatestDocumentsPathParams { vault_id }): Path<FetchLatestDocumentsPathParams>,
    State(state): State<AppState>,
) -> Result<Json<Vec<DocumentVersionWithoutContent>>, SyncServerError> {
    debug!("Fetching latest documents in {vault_id}");

    state
        .database
        .get_latest_documents(&vault_id, None)
        .await
        .map(Json)
        .map_err(server_error)
}
