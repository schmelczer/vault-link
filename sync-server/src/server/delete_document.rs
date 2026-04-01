use anyhow::Context;
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use axum_extra::TypedHeader;
use log::{debug, info};
use serde::Deserialize;

use super::{device_id_header::DeviceIdHeader, requests::DeleteDocumentVersion};
use crate::{
    app_state::{
        AppState,
        database::models::{
            DocumentId, DocumentVersionWithoutContent, StoredDocumentVersion, VaultId,
        },
    },
    config::user_config::User,
    errors::{SyncServerError, server_error, write_transaction_error},
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
    Json(_request): Json<DeleteDocumentVersion>,
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

    if let Some(latest_version) = &latest_version
        && latest_version.is_deleted
    {
        transaction
            .rollback()
            .await
            .context("Failed to roll back transaction")
            .map_err(server_error)?;

        info!("Document `{document_id}` has already been deleted",);
        return Ok(Json(latest_version.clone().into()));
    }

    let (latest_relative_path, latest_content) = latest_version.map_or_else(
        || (String::new(), Vec::new()),
        |version| (version.relative_path, version.content),
    );

    let new_version = StoredDocumentVersion {
        vault_update_id: last_update_id + 1,
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
        .insert_document_version(&vault_id, &new_version, Some(transaction))
        .await
        .map_err(server_error)?;

    Ok(Json(new_version.into()))
}
