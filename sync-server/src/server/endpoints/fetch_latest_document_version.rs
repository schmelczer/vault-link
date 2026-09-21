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
        database::models::{DocumentId, DocumentVersion, DocumentVersionWithoutContent},
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

pub async fn fetch_latest_document_metadata(
    Path((VaultPath(vault_id), document_id)): Path<(VaultPath, DocumentId)>,
    State(state): State<AppState>,
) -> Result<Json<DocumentVersionWithoutContent>, SyncServerError> {
    let mut tx = state
        .database
        .create_readonly_transaction(&vault_id)
        .await
        .map_err(server_error)?;
    let metadata = sqlx::query_as::<_, DocumentVersionWithoutContent>(
        "SELECT vault_update_id, document_id, updated_date, user_id, device_id, length(content) AS content_size
         FROM documents WHERE document_id = ? ORDER BY vault_update_id DESC LIMIT 1"
    ).bind(document_id.hyphenated()).fetch_optional(&mut *tx).await
        .map_err(|error| server_error(error.into()))?
        .ok_or_else(|| not_found_error(anyhow!("Document does not exist")))?;
    Ok(Json(metadata))
}
