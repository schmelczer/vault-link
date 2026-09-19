use anyhow::anyhow;
use axum::{
    Json,
    extract::{Path, State},
};
use log::debug;

use super::VaultPath;
use crate::{
    app_state::{
        AppState,
        database::models::{DocumentId, DocumentVersion},
    },
    errors::{SyncServerError, not_found_error, server_error},
};

#[axum::debug_handler]
pub async fn fetch_latest_document_version(
    Path((VaultPath(vault_id), document_id)): Path<(VaultPath, DocumentId)>,
    State(state): State<AppState>,
) -> Result<Json<DocumentVersion>, SyncServerError> {
    debug!("Fetching latest document version for document `{document_id}` in vault `{vault_id}`");

    let latest_version = state
        .database
        .get_latest_document_version(&vault_id, &document_id, None)
        .await
        .map_err(server_error)?
        .map_or_else(
            || {
                Err(not_found_error(anyhow!(
                    "Document with id `{document_id}` not found",
                )))
            },
            Ok,
        )?;

    Ok(Json(latest_version.into()))
}
