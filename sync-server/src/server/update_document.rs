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
    errors::{SyncServerError, client_error, not_found_error, server_error},
    server::requests::UpdateBinaryDocumentVersion,
    utils::{
        find_first_available_path::find_first_available_path, is_binary::as_non_binary_text,
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
        .await?;

    update_document(
        &parent_document.relative_path,
        parent_document.content,
        vault_id,
        document_id,
        request.relative_path.as_deref(),
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
        .await?;

    update_document(
        &parent_document.relative_path,
        parent_document.content,
        vault_id,
        document_id,
        request.relative_path.as_deref(),
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
        .await?
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
    relative_path: Option<&str>,
    content: Vec<u8>,
    user: User,
    device_id: DeviceIdHeader,
    state: AppState,
    mut transaction: WriteTransaction,
) -> Result<Json<DocumentUpdateResponse>, SyncServerError> {
    debug!("Updating document `{document_id}` in vault `{vault_id}`");

    let sanitized_relative_path = relative_path
        .map(sanitize_path)
        .transpose()
        .map_err(client_error)?;

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
        .await?
        .map_or_else(
            || {
                Err(not_found_error(anyhow!(
                    "Document with id `{document_id}` not found",
                )))
            },
            Ok,
        )?;

    if latest_version.is_deleted {
        transaction.rollback().await?;

        info!("Document `{document_id}` has been deleted, ignoring update to it",);
        return Ok(Json(DocumentUpdateResponse::FastForwardUpdate(
            latest_version.into(),
        )));
    }

    // Return the latest version if the content and path are the same as the latest
    // version. A missing relative_path means "keep current path", so the path
    // is implicitly unchanged.
    let path_unchanged = sanitized_relative_path
        .as_deref()
        .is_none_or(|p| p == latest_version.relative_path);
    if content == latest_version.content && path_unchanged {
        info!(
            "Document content is the same as the latest version for `{document_id}`, skipping update"
        );
        transaction.rollback().await?;

        return Ok(Json(DocumentUpdateResponse::FastForwardUpdate(
            latest_version.into(),
        )));
    }

    // For mergability, use whichever path the new version will live at:
    // - the requested rename target if the client sent one
    // - otherwise the existing server-side path.
    let mergable_check_path = sanitized_relative_path
        .as_deref()
        .unwrap_or(&latest_version.relative_path);

    let mergeable_texts = if is_file_type_mergable(
        mergable_check_path,
        &state.config.server.mergeable_file_extensions,
    ) {
        as_non_binary_texts(&parent_content, &latest_version.content, &content)
    } else {
        None
    };
    let are_all_participants_mergable = mergeable_texts.is_some();

    let (merged_content, is_same_as_request) =
        if let Some((parent_text, latest_text, new_text)) = mergeable_texts {
            info!("Merging changes for document `{document_id}` in vault `{vault_id}`");

            let parent_owned = parent_text.to_owned();
            let latest_owned = latest_text.to_owned();
            let new_owned = new_text.to_owned();
            let content_clone = content.clone();

            let merged = tokio::task::spawn_blocking(move || {
                
                reconcile(
                    &parent_owned,
                    &latest_owned.into(),
                    &new_owned.into(),
                    &*BuiltinTokenizer::Word,
                )
                .apply()
                .text()
                .into_bytes()
            })
            .await
            .map_err(|e| server_error(anyhow::anyhow!("Reconcile task failed: {e}")))?;

            let is_same = merged == content_clone;
            (merged, is_same)
        } else {
            (content, true) // true means that the client doesn't need to refetch the file as we can ensure the remote and local versions are the same as LWW is the merging method for binary files
        };

    // First rename wins: apply the client's rename only if the doc's path
    // hasn't changed since its parent version. Content from both clients
    // still merges via the 3-way reconcile above
    let new_relative_path = match sanitized_relative_path.as_deref() {
        Some(requested)
            if parent_relative_path == latest_version.relative_path
                && requested != latest_version.relative_path =>
        {
            let new_path =
                find_first_available_path(&vault_id, requested, &state.database, &mut transaction)
                    .await?;

            if new_path != requested {
                info!(
                    "Document already exists at new location: `{requested}` when trying to update it in vault `{vault_id}`, deconflicting by creating at `{new_path}`"
                );
            }

            new_path
        }
        _ => latest_version.relative_path.clone(),
    };

    let new_version = StoredDocumentVersion {
        document_id,
        vault_update_id: last_update_id
            .checked_add(1)
            .ok_or_else(|| server_error(anyhow!("Vault update id overflow")))?,
        creation_vault_update_id: latest_version.creation_vault_update_id,
        relative_path: new_relative_path,
        content: merged_content,
        updated_date: chrono::Utc::now(),
        is_deleted: false,
        user_id: user.name,
        device_id: device_id.0,
        has_been_merged: are_all_participants_mergable && !is_same_as_request,
    };

    state
        .database
        .insert_document_version(&vault_id, &new_version, transaction)
        .await?;

    Ok(Json(if is_same_as_request {
        DocumentUpdateResponse::FastForwardUpdate(new_version.into())
    } else {
        DocumentUpdateResponse::MergingUpdate(new_version.into())
    }))
}

fn as_non_binary_texts<'a>(
    parent_content: &'a [u8],
    latest_content: &'a [u8],
    new_content: &'a [u8],
) -> Option<(&'a str, &'a str, &'a str)> {
    Some((
        as_non_binary_text(parent_content)?,
        as_non_binary_text(latest_content)?,
        as_non_binary_text(new_content)?,
    ))
}
