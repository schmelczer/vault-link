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
            WriteTransaction,
            models::{DocumentId, StoredDocumentVersion, VaultId, VaultUpdateId},
        },
    },
    config::user_config::User,
    errors::{
        SyncServerError, client_error, not_found_error, server_error, write_transaction_error,
    },
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
    let parent_document =
        get_parent_document(&state, &vault_id, &document_id, request.parent_version_id).await?;
    let content = request.content.contents.to_vec();

    let transaction = state
        .database
        .create_write_transaction(&vault_id)
        .await
        .map_err(write_transaction_error)?;

    update_document(
        &parent_document.relative_path,
        parent_document.content,
        vault_id,
        document_id,
        &request.relative_path,
        content,
        user,
        device_id,
        state,
        transaction,
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
    let parent_document =
        get_parent_document(&state, &vault_id, &document_id, request.parent_version_id).await?;

    let parent_text = str::from_utf8(&parent_document.content)
        .context("Parent version contains binary content; use putBinary instead of putText")
        .map_err(client_error)?;

    let edited_text = EditedText::from_diff(parent_text, request.content, &*BuiltinTokenizer::Word)
        .context("Failed to apply given diff to parent document")
        .map_err(client_error)?;

    let content = edited_text.apply().text().into_bytes();

    let transaction = state
        .database
        .create_write_transaction(&vault_id)
        .await
        .map_err(write_transaction_error)?;

    update_document(
        &parent_document.relative_path,
        parent_document.content,
        vault_id,
        document_id,
        &request.relative_path,
        content,
        user,
        device_id,
        state,
        transaction,
    )
    .await
}

async fn get_parent_document(
    state: &AppState,
    vault_id: &VaultId,
    document_id: &DocumentId,
    parent_version_id: VaultUpdateId,
) -> Result<StoredDocumentVersion, SyncServerError> {
    let parent = state
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
        )?;

    if &parent.document_id != document_id {
        return Err(client_error(anyhow!(
            "Parent version `{parent_version_id}` does not belong to document `{document_id}`"
        )));
    }

    Ok(parent)
}

#[allow(clippy::too_many_lines, clippy::too_many_arguments)]
pub async fn update_document(
    parent_relative_path: &str,
    parent_content: Vec<u8>,
    vault_id: VaultId,
    document_id: DocumentId,
    relative_path: &str,
    content: Vec<u8>,
    user: User,
    device_id: DeviceIdHeader,
    state: AppState,
    mut transaction: WriteTransaction,
) -> Result<Json<DocumentUpdateResponse>, SyncServerError> {
    debug!("Updating document `{document_id}` in vault `{vault_id}`");

    let sanitized_relative_path = sanitize_path(relative_path).map_err(client_error)?;

    let last_update_id = state
        .database
        .get_max_update_id_in_vault(&vault_id, Some(&mut transaction))
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

    // Return the latest version if the content and path are the same as the latest
    // version
    if content == latest_version.content && sanitized_relative_path == latest_version.relative_path
    {
        info!(
            "Document content is the same as the latest version for `{document_id}`, skipping update"
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
        &sanitized_relative_path,
        &state.config.server.mergeable_file_extensions,
    ) && !is_binary(&parent_content)
        && !is_binary(&latest_version.content)
        && !is_binary(&content);

    let (merged_content, is_different_from_request_content) = if are_all_participants_mergable {
        info!("Merging changes for document `{document_id}` in vault `{vault_id}`");
        let parent_text = str::from_utf8(&parent_content)
            .context("Parent document content is not valid UTF-8")
            .map_err(client_error)?;
        let latest_text = str::from_utf8(&latest_version.content)
            .context("Latest version content is not valid UTF-8")
            .map_err(client_error)?;
        let new_text = str::from_utf8(&content)
            .context("New content is not valid UTF-8")
            .map_err(client_error)?;
        let parent_owned = parent_text.to_owned();
        let latest_owned = latest_text.to_owned();
        let new_owned = new_text.to_owned();
        let content_clone = content.clone();

        let (merged, is_different) = tokio::task::spawn_blocking(move || {
            let merged = reconcile(
                &parent_owned,
                &latest_owned.into(),
                &new_owned.into(),
                &*BuiltinTokenizer::Word,
            )
            .apply()
            .text()
            .into_bytes();
            let is_different = merged != content_clone;
            (merged, is_different)
        })
        .await
        .map_err(|e| server_error(anyhow::anyhow!("Reconcile task failed: {e}")))?;

        (merged, is_different)
    } else {
        (content, false) // false means that the client doesn't need to refetch the file as we can ensure the remote and local versions are the same as LWW is the merging method for binary files
    };

    // Rename resolution: only apply the client's rename if the document's path
    // hasn't changed since this client's parent version. Check the parent
    // version's path against the latest version's path. If they differ, another
    // client already renamed the document — keep the latest path (first rename
    // wins). Content changes from both clients are still merged correctly via
    // the 3-way reconcile above, independent of which rename wins.
    let new_relative_path = if parent_relative_path == latest_version.relative_path
        && sanitized_relative_path != latest_version.relative_path
    {
        let new_path = find_first_available_path(
            &vault_id,
            &sanitized_relative_path,
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

    let new_version = StoredDocumentVersion {
        document_id,
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
        .insert_document_version(&vault_id, &new_version, transaction)
        .await
        .map_err(server_error)?;

    Ok(Json(if is_different_from_request_content {
        DocumentUpdateResponse::MergingUpdate(new_version.into())
    } else {
        DocumentUpdateResponse::FastForwardUpdate(new_version.into())
    }))
}
