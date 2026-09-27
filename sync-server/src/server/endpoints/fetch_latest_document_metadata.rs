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
        database::{
            Database,
            models::{DocumentId, DocumentVersionWithoutContent},
        },
    },
    errors::{SyncServerError, not_found_error},
};

#[axum::debug_handler]
pub async fn fetch_latest_document_metadata(
    Path((VaultPath(vault_id), document_id)): Path<(VaultPath, DocumentId)>,
    State(state): State<AppState>,
) -> Result<Json<DocumentVersionWithoutContent>, SyncServerError> {
    debug!("Fetching latest document metadata for document `{document_id}` in vault `{vault_id}`");

    let mut tx = state
        .database
        .create_readonly_transaction(&vault_id)
        .await?;

    let metadata = Database::get_latest_document_metadata(&mut tx, &document_id)
        .await?
        .ok_or_else(|| not_found_error(anyhow!("Document does not exist")))?;

    Ok(Json(metadata))
}
