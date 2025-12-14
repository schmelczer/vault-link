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
        database::models::{StoredDocumentVersion, VaultId},
    },
    config::user_config::User,
    errors::{SyncServerError, server_error},
    server::{responses::DocumentUpdateResponse, update_document::merge_with_stored_version},
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
) -> Result<Json<DocumentUpdateResponse>, SyncServerError> {
    debug!("Creating document in vault `{vault_id}`");

    let mut transaction = state
        .database
        .create_write_transaction(&vault_id)
        .await
        .map_err(server_error)?;

    let sanitized_relative_path = sanitize_path(&request.relative_path);

    if request.force_merge.unwrap_or_default() {
        let latest_version = state
            .database
            .get_latest_document_by_path(
                &vault_id,
                &sanitized_relative_path,
                Some(&mut transaction),
            )
            .await
            .map_err(server_error)?;
        if let Some(latest_version) = latest_version {
            info!(
                "Document already exists at new location: `{sanitized_relative_path}` when trying to create it in vault `{vault_id}`, merging into existing document"
            );

            return merge_with_stored_version(
                latest_version.clone(),
                latest_version,
                vault_id,
                user,
                device_id,
                state,
                &sanitized_relative_path,
                request.content.contents.to_vec(),
                transaction,
            )
            .await;
        }
    }

    let document_id = uuid::Uuid::new_v4();

    let last_update_id = state
        .database
        .get_max_update_id_in_vault(&vault_id, Some(&mut transaction))
        .await
        .map_err(server_error)?;

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

    Ok(Json(DocumentUpdateResponse::FastForwardUpdate(
        new_version.into(),
    )))
}
