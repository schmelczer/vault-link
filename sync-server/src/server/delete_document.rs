use anyhow::anyhow;
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
        database::models::{
            DocumentId, DocumentVersionWithoutContent, StoredDocumentVersion, VaultId,
        },
    },
    config::user_config::User,
    errors::{SyncServerError, not_found_error, server_error},
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
        .await?;

    let last_update_id = state
        .database
        .get_max_update_id_in_vault(
            &vault_id,
            Some(transaction.connection_mut().map_err(server_error)?),
        )
        .await?;

    let latest_version = state
        .database
        .get_latest_document(
            &vault_id,
            &document_id,
            Some(transaction.connection_mut().map_err(server_error)?),
        )
        .await?;

    let Some(latest_version) = latest_version else {
        transaction.rollback().await?;
        return Err(not_found_error(anyhow!(
            "Document `{document_id}` not found in vault `{vault_id}`"
        )));
    };

    if latest_version.is_deleted {
        transaction.rollback().await?;

        info!("Document `{document_id}` has already been deleted",);
        return Ok(Json(latest_version.into()));
    }

    let new_vault_update_id = last_update_id
        .checked_add(1)
        .ok_or_else(|| server_error(anyhow!("Vault update id overflow")))?;
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
        .await?;

    Ok(Json(new_version.into()))
}
