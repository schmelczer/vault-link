use axum::{
    Json,
    extract::{Path, State},
};
use log::debug;
use serde::Deserialize;

use crate::{
    app_state::{
        AppState,
        database::models::{DocumentId, DocumentVersionWithoutContent, VaultId},
    },
    errors::{SyncServerError, server_error},
    utils::normalize::normalize,
};

#[derive(Deserialize)]
pub struct FetchDocumentVersionsPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,

    document_id: DocumentId,
}

#[axum::debug_handler]
pub async fn fetch_document_versions(
    Path(FetchDocumentVersionsPathParams {
        vault_id,
        document_id,
    }): Path<FetchDocumentVersionsPathParams>,
    State(state): State<AppState>,
) -> Result<Json<Vec<DocumentVersionWithoutContent>>, SyncServerError> {
    debug!("Fetching all versions for document `{document_id}` in vault `{vault_id}`");

    let versions = state
        .database
        .get_document_versions(&vault_id, &document_id, None)
        .await
        .map_err(server_error)?;

    Ok(Json(versions))
}
