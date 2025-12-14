use anyhow::{Context as _, anyhow};
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use axum_extra::TypedHeader;
use axum_typed_multipart::TypedMultipart;
use log::{debug, info};
use reconcile_text::{BuiltinTokenizer, EditedText, reconcile};
use serde::Deserialize;

use super::{
    device_id_header::DeviceIdHeader, requests::UpdateTextDocumentVersion,
    responses::DocumentUpdateResponse,
};
use crate::{
    app_state::{
        AppState,
        database::{
            Transaction,
            models::{DocumentId, StoredDocumentVersion, VaultId, VaultUpdateId},
        },
    },
    config::user_config::User,
    errors::{SyncServerError, client_error, not_found_error, server_error},
    server::requests::UpdateBinaryDocumentVersion,
    utils::{
        find_first_available_path::find_first_available_path, is_binary::is_binary,
        is_file_type_mergable::is_file_type_mergable, normalize::normalize,
        sanitize_path::sanitize_path,
    },
};

#[derive(Deserialize)]
pub struct UpdateDocumentPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
    document_id: DocumentId,
}

#[axum::debug_handler]
pub async fn update_binary(
    Path(UpdateDocumentPathParams {
        vault_id,
        document_id,
    }): Path<UpdateDocumentPathParams>,
    Extension(user): Extension<User>,
    TypedHeader(device_id): TypedHeader<DeviceIdHeader>,
    State(state): State<AppState>,
    TypedMultipart(request): TypedMultipart<UpdateBinaryDocumentVersion>,
) -> Result<Json<DocumentUpdateResponse>, SyncServerError> {
    let parent_document = get_parent_document(&state, &vault_id, request.parent_version_id).await?;
    let content = request.content.contents.to_vec();

    update_document(
        parent_document,
        vault_id,
        document_id,
        user,
        device_id,
        state,
        &request.relative_path,
        content,
    )
    .await
}

#[axum::debug_handler]
#[allow(clippy::too_many_lines)]
pub async fn update_text(
    Path(UpdateDocumentPathParams {
        vault_id,
        document_id,
    }): Path<UpdateDocumentPathParams>,
    Extension(user): Extension<User>,
    TypedHeader(device_id): TypedHeader<DeviceIdHeader>,
    State(state): State<AppState>,
    Json(request): Json<UpdateTextDocumentVersion>,
) -> Result<Json<DocumentUpdateResponse>, SyncServerError> {
    let parent_document = get_parent_document(&state, &vault_id, request.parent_version_id).await?;

    let edited_text = EditedText::from_diff(
        str::from_utf8(&parent_document.content)
            .expect("parent must be valid UTF-8 because it's a text document"),
        request.content,
        &*BuiltinTokenizer::Word,
    )
    .context("Failed to apply given diff to parent document")
    .map_err(client_error)?;

    let content = edited_text.apply().text().into_bytes();

    update_document(
        parent_document,
        vault_id,
        document_id,
        user,
        device_id,
        state,
        &request.relative_path,
        content,
    )
    .await
}

async fn get_parent_document(
    state: &AppState,
    vault_id: &VaultId,
    parent_version_id: VaultUpdateId,
) -> Result<StoredDocumentVersion, SyncServerError> {
    state
        .database
        .get_document_version(vault_id, parent_version_id, None)
        .await
        .map_err(server_error)?
        .map_or_else(
            || {
                Err(not_found_error(anyhow!(
                    "Parent version with id `{parent_version_id}` not found"
                )))
            },
            Ok,
        )
}

#[allow(clippy::too_many_lines, clippy::too_many_arguments)]
async fn update_document(
    parent_document: StoredDocumentVersion,
    vault_id: VaultId,
    document_id: DocumentId,
    user: User,
    device_id: DeviceIdHeader,
    state: AppState,
    relative_path: &str,
    content: Vec<u8>,
) -> Result<Json<DocumentUpdateResponse>, SyncServerError> {
    debug!("Updating document `{document_id}` in vault `{vault_id}`");

    let sanitized_relative_path = sanitize_path(relative_path);

    let mut transaction = state
        .database
        .create_write_transaction(&vault_id)
        .await
        .map_err(server_error)?;

    let latest_version = state
        .database
        .get_latest_document(&vault_id, &document_id, Some(&mut transaction))
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

    if latest_version.is_deleted {
        transaction
            .rollback()
            .await
            .context("Failed to roll back transaction")
            .map_err(server_error)?;

        info!("Document `{document_id}` has been deleted, ignoring update to it",);
        return Ok(Json(DocumentUpdateResponse::FastForwardUpdate(
            latest_version.into(),
        )));
    }

    merge_with_stored_version(
        parent_document,
        latest_version,
        vault_id,
        user,
        device_id,
        state,
        &sanitized_relative_path,
        content,
        transaction,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn merge_with_stored_version(
    parent_document: StoredDocumentVersion,
    latest_version: StoredDocumentVersion,
    vault_id: VaultId,
    user: User,
    device_id: DeviceIdHeader,
    state: AppState,
    sanitized_relative_path: &str,
    content: Vec<u8>,
    mut transaction: Transaction<'_>,
) -> Result<Json<DocumentUpdateResponse>, SyncServerError> {
    // Return the latest version if the content and path are the same as the latest
    // version
    if content == latest_version.content && sanitized_relative_path == latest_version.relative_path
    {
        info!(
            "Document content is the same as the latest version for `{}`, skipping update",
            parent_document.document_id
        );
        transaction
            .rollback()
            .await
            .context("Failed to roll back transaction")
            .map_err(server_error)?;

        return Ok(Json(DocumentUpdateResponse::FastForwardUpdate(
            latest_version.into(),
        )));
    }

    let are_all_participants_mergable = is_file_type_mergable(
        sanitized_relative_path,
        &state.config.server.mergeable_file_extensions,
    ) && !is_binary(&parent_document.content)
        && !is_binary(&latest_version.content)
        && !is_binary(&content);

    let merged_content = if are_all_participants_mergable {
        info!(
            "Merging changes for document `{}` in vault `{vault_id}`",
            parent_document.document_id
        );
        reconcile(
            str::from_utf8(&parent_document.content)
                .expect("parent must be valid UTF-8 because it's not binary"),
            &str::from_utf8(&latest_version.content)
                .expect("latest_version must be valid UTF-8 because it's not binary")
                .into(),
            &str::from_utf8(&content)
                .expect("content must be valid UTF-8 because it's not binary")
                .into(),
            &*BuiltinTokenizer::Word,
        )
        .apply()
        .text()
        .into_bytes()
    } else {
        content.clone()
    };

    let is_different_from_request_content = merged_content != content;

    // We can only update the relative path if we're the first one to do so
    let new_relative_path = if parent_document.relative_path == latest_version.relative_path
        && latest_version.relative_path != sanitized_relative_path
    {
        let new_path = find_first_available_path(
            &vault_id,
            sanitized_relative_path,
            &state.database,
            &mut transaction,
        )
        .await
        .map_err(server_error)?;

        if new_path != sanitized_relative_path {
            info!(
                "Document already exists at new location: `{sanitized_relative_path}` when trying to update it in vault `{vault_id}`, deconflicting by creating at `{new_path}`"
            );
        }

        new_path
    } else {
        latest_version.relative_path.clone()
    };

    let last_update_id = state
        .database
        .get_max_update_id_in_vault(&vault_id, Some(&mut transaction))
        .await
        .map_err(server_error)?;

    let new_version = StoredDocumentVersion {
        document_id: parent_document.document_id,
        vault_update_id: last_update_id + 1,
        relative_path: new_relative_path,
        content: merged_content,
        updated_date: chrono::Utc::now(),
        is_deleted: false,
        user_id: user.name,
        device_id: device_id.0,
        has_been_merged: are_all_participants_mergable && is_different_from_request_content,
    };

    state
        .database
        .insert_document_version(&vault_id, &new_version, Some(transaction))
        .await
        .map_err(server_error)?;

    Ok(Json(if is_different_from_request_content {
        DocumentUpdateResponse::MergingUpdate(new_version.into())
    } else {
        DocumentUpdateResponse::FastForwardUpdate(new_version.into())
    }))
}
