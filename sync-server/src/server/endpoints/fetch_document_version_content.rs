use anyhow::anyhow;
use axum::{
    body::Bytes,
    extract::{Path, State},
};
use log::debug;

use super::VaultPath;
use crate::{
    app_state::{
        AppState,
        database::models::{DocumentId, VaultUpdateId},
    },
    errors::{SyncServerError, not_found_error, server_error},
};

#[axum::debug_handler]
pub async fn fetch_document_version_content(
    Path((VaultPath(vault_id), document_id, vault_update_id)): Path<(
        VaultPath,
        DocumentId,
        VaultUpdateId,
    )>,
    State(state): State<AppState>,
) -> Result<Bytes, SyncServerError> {
    debug!(
        "Fetching document version `{vault_update_id}` for document `{document_id}` in vault `{vault_id}`"
    );

    let result = state
        .database
        .get_document_version(&vault_id, vault_update_id, None)
        .await
        .map_err(server_error)?
        .map_or_else(
            || {
                Err(not_found_error(anyhow!(
                    "Document with vault update id `{vault_update_id}` not found",
                )))
            },
            Ok,
        )?;

    if result.document_id != document_id {
        return Err(not_found_error(anyhow!(
            "Document with document id `{document_id}` does not have a version with id \
            `{vault_update_id}`",
        )));
    }

    Ok(result.content.into())
}
