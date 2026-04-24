use anyhow::{Context, anyhow};
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use axum_extra::TypedHeader;
use log::{debug, info};
use serde::Deserialize;

use super::device_id_header::DeviceIdHeader;
use crate::{
    app_state::{
        AppState,
        database::models::{DocumentId, DocumentVersionWithoutContent, StoredDocumentVersion, VaultId},
    },
    config::user_config::User,
    errors::{SyncServerError, not_found_error, server_error, write_transaction_error},
    utils::normalize::normalize,
};

#[derive(Deserialize)]
pub struct DeleteDocumentPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,

    document_id: DocumentId,
}

#[axum::debug_handler]
pub async fn delete_document(
    Path(DeleteDocumentPathParams {
        vault_id,
        document_id,
    }): Path<DeleteDocumentPathParams>,
    Extension(user): Extension<User>,
    TypedHeader(device_id): TypedHeader<DeviceIdHeader>,
    State(state): State<AppState>,
) -> Result<Json<DocumentVersionWithoutContent>, SyncServerError> {
    debug!("Deleting document `{document_id}` in vault `{vault_id}`");

    let mut transaction = state
        .database
        .create_write_transaction(&vault_id)
        .await
        .map_err(write_transaction_error)?;

    let last_update_id = state
        .database
        .get_max_update_id_in_vault(&vault_id, Some(&mut transaction))
        .await
        .map_err(server_error)?;

    let latest_version = state
        .database
        .get_latest_document(&vault_id, &document_id, Some(&mut transaction))
        .await
        .map_err(server_error)?;

    let Some(latest_version) = latest_version else {
        transaction
            .rollback()
            .await
            .context("Failed to roll back transaction")
            .map_err(server_error)?;
        return Err(not_found_error(anyhow!(
            "Document `{document_id}` not found in vault `{vault_id}`"
        )));
    };

    if latest_version.is_deleted {
        transaction
            .rollback()
            .await
            .context("Failed to roll back transaction")
            .map_err(server_error)?;

        info!("Document `{document_id}` has already been deleted",);
        return Ok(Json(latest_version.into()));
    }

    let new_vault_update_id = last_update_id + 1;
    let latest_relative_path = latest_version.relative_path;
    let latest_content = latest_version.content;
    let creation_vault_update_id = latest_version.creation_vault_update_id;

    let new_version = StoredDocumentVersion {
        vault_update_id: new_vault_update_id,
        creation_vault_update_id,
        document_id,
        relative_path: latest_relative_path,
        content: latest_content, // copy the content from the latest version
        updated_date: chrono::Utc::now(),
        is_deleted: true,
        user_id: user.name,
        device_id: device_id.0,
        has_been_merged: false,
    };

    state
        .database
        .insert_document_version(&vault_id, &new_version, transaction)
        .await
        .map_err(server_error)?;

    Ok(Json(new_version.into()))
}
