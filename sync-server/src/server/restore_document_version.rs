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
        database::{
            InsertBroadcast,
            models::{
                DocumentId, DocumentVersionWithoutContent, StoredDocumentVersion, VaultId,
                VaultUpdateId,
            },
        },
    },
    config::user_config::User,
    errors::{SyncServerError, client_error, not_found_error, server_error, write_transaction_error},
    utils::{find_first_available_path::find_first_available_path, normalize::normalize},
};

#[derive(Deserialize)]
pub struct RestorePathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,

    document_id: DocumentId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreDocumentVersionRequest {
    pub vault_update_id: VaultUpdateId,
}

#[axum::debug_handler]
pub async fn restore_document_version(
    Path(RestorePathParams {
        vault_id,
        document_id,
    }): Path<RestorePathParams>,
    Extension(user): Extension<User>,
    TypedHeader(device_id): TypedHeader<DeviceIdHeader>,
    State(state): State<AppState>,
    Json(request): Json<RestoreDocumentVersionRequest>,
) -> Result<Json<DocumentVersionWithoutContent>, SyncServerError> {
    debug!(
        "Restoring document `{document_id}` in vault `{vault_id}` to version `{}`",
        request.vault_update_id
    );

    if request.vault_update_id <= 0 {
        return Err(client_error(anyhow!(
            "Invalid vault_update_id: `{}`",
            request.vault_update_id
        )));
    }

    let mut transaction = state
        .database
        .create_write_transaction(&vault_id)
        .await
        .map_err(write_transaction_error)?;

    let target_version = state
        .database
        .get_document_version(&vault_id, request.vault_update_id, Some(&mut *transaction))
        .await
        .map_err(server_error)?
        .ok_or_else(|| {
            not_found_error(anyhow!("Version `{}` not found", request.vault_update_id))
        })?;

    if target_version.document_id != document_id {
        transaction.rollback().await.map_err(server_error)?;
        return Err(not_found_error(anyhow!(
            "Version `{}` does not belong to document `{document_id}`",
            request.vault_update_id,
        )));
    }

    if target_version.is_deleted {
        transaction.rollback().await.map_err(server_error)?;
        return Err(client_error(anyhow!(
            "Cannot restore to a deleted version `{}`",
            request.vault_update_id,
        )));
    }

    let existing = state
        .database
        .get_latest_non_deleted_document_by_path(
            &vault_id,
            &target_version.relative_path,
            Some(&mut *transaction),
        )
        .await
        .map_err(server_error)?;

    let restore_path = if let Some(existing_doc) = &existing
        && existing_doc.document_id != document_id
    {
        find_first_available_path(
            &vault_id,
            &target_version.relative_path,
            &state.database,
            &mut transaction,
        )
        .await
        .map_err(server_error)?
    } else {
        target_version.relative_path.clone()
    };

    let last_update_id = state
        .database
        .get_max_update_id_in_vault(&vault_id, Some(&mut *transaction))
        .await
        .map_err(server_error)?;

    // The current latest (pre-restore) is our baseline for deciding
    // whether content and/or path actually change.
    let current_latest = state
        .database
        .get_latest_document(&vault_id, &document_id, Some(&mut *transaction))
        .await
        .map_err(server_error)?;

    let new_version = StoredDocumentVersion {
        vault_update_id: last_update_id + 1,
        creation_vault_update_id: target_version.creation_vault_update_id,
        document_id,
        relative_path: restore_path,
        content: target_version.content,
        updated_date: chrono::Utc::now(),
        is_deleted: false,
        user_id: user.name.clone(),
        device_id: device_id.0.clone(),
        has_been_merged: false,
    };

    let (content_changed, path_changed) = match &current_latest {
        Some(prev) => (
            prev.content != new_version.content || prev.is_deleted,
            prev.relative_path != new_version.relative_path,
        ),
        // No prior version (shouldn't happen in practice — target_version
        // already proved the document exists — but treat defensively).
        None => (true, true),
    };

    state
        .database
        .insert_document_version(
            &vault_id,
            &new_version,
            transaction,
            InsertBroadcast {
                content_changed,
                path_changed,
            },
        )
        .await
        .map_err(server_error)?;

    info!(
        "Restored document `{document_id}` to version `{}` as new version `{}`",
        request.vault_update_id, new_version.vault_update_id
    );

    Ok(Json(new_version.into()))
}
