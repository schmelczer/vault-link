use axum::{
    Extension, Json,
    extract::{Path, State},
};
use axum_extra::TypedHeader;
use axum_typed_multipart::TypedMultipart;
use log::{debug, info};
use serde::Deserialize;

use super::{device_id_header::DeviceIdHeader, requests::CreateDocumentVersion};
use crate::{
    app_state::{
        AppState,
        database::models::{DocumentVersionWithoutContent, StoredDocumentVersion, VaultId},
    },
    config::user_config::User,
    errors::{SyncServerError, client_error, server_error},
    utils::{
        find_first_available_path::find_first_available_path, normalize::normalize,
        sanitize_path::sanitize_path,
    },
};

#[derive(Deserialize)]
pub struct CreateDocumentPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
}

/// Create a new document in case a document with the same doesn't exist
/// already. If a document with the same path exists, a new version is created
/// with their content merged.
#[axum::debug_handler]
pub async fn create_document(
    Path(CreateDocumentPathParams { vault_id }): Path<CreateDocumentPathParams>,
    Extension(user): Extension<User>,
    TypedHeader(device_id): TypedHeader<DeviceIdHeader>,
    State(state): State<AppState>,
    TypedMultipart(request): TypedMultipart<CreateDocumentVersion>,
) -> Result<Json<DocumentVersionWithoutContent>, SyncServerError> {
    debug!("Creating document in vault `{vault_id}`");

    let mut transaction = state
        .database
        .create_write_transaction(&vault_id)
        .await
        .map_err(server_error)?;

    let document_id = match request.document_id {
        Some(document_id) => {
            let existing_version = state
                .database
                .get_latest_document(&vault_id, &document_id, Some(&mut transaction))
                .await
                .map_err(server_error)?;

            if existing_version.is_some() {
                return Err(client_error(anyhow::anyhow!(
                    "Document with the same ID `{document_id}` already exists"
                )));
            }

            document_id
        }
        None => uuid::Uuid::new_v4(),
    };

    let last_update_id = state
        .database
        .get_max_update_id_in_vault(&vault_id, Some(&mut transaction))
        .await
        .map_err(server_error)?;

    let sanitized_relative_path = sanitize_path(&request.relative_path);
    let deduped_path = find_first_available_path(
        &vault_id,
        &sanitized_relative_path,
        &state.database,
        &mut transaction,
    )
    .await
    .map_err(server_error)?;

    if deduped_path != sanitized_relative_path {
        info!(
            "Document already exists at new location: `{sanitized_relative_path}` when trying to create it in vault `{vault_id}`, deconflicting by creating at `{deduped_path}`"
        );
    }

    let new_version = StoredDocumentVersion {
        vault_update_id: last_update_id + 1,
        document_id,
        relative_path: deduped_path,
        content: request.content.contents.to_vec(),
        updated_date: chrono::Utc::now(),
        is_deleted: false,
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
