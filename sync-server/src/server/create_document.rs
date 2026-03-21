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
    server::{
        responses::DocumentUpdateResponse,
        update_document::{MergeInput, merge_with_stored_version},
    },
    utils::{
        dedup_paths::get_base_path, find_first_available_path::find_first_available_path,
        is_binary::is_binary, is_file_type_mergable::is_file_type_mergable, normalize::normalize,
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
///
/// Text content must be UTF-8 encoded. Clients are responsible for
/// transcoding other encodings (e.g. UTF-16) to UTF-8 before sending.
#[axum::debug_handler]
#[allow(clippy::too_many_lines)]
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

    if let Some(ref idempotency_key) = request.idempotency_key {
        let existing = state
            .database
            .get_document_by_idempotency_key(&vault_id, idempotency_key, Some(&mut *transaction))
            .await
            .map_err(server_error)?;
        if let Some(existing) = existing {
            if existing.is_deleted {
                // The document was created (storing the key) and later deleted.
                // Don't return the deleted version — it would cause the client
                // to delete its local file. Instead, fall through to normal
                // create so the client's content is preserved as a new document.
                // The unique index excludes deleted rows (WHERE is_deleted = 0),
                // so keeping the key does NOT cause a constraint violation —
                // the new non-deleted version can safely reuse the same key.
                info!(
                    "Idempotency key `{idempotency_key}` matches a deleted document, ignoring and creating fresh"
                );
            } else {
                // Return the LATEST version of the document, not the version
                // that originally stored the key. The document may have been
                // modified by other clients since the key was stored, and
                // returning a stale version would cause the client to cache
                // incorrect content, breaking subsequent diffs.
                let latest = state
                    .database
                    .get_latest_document(&vault_id, &existing.document_id, Some(&mut *transaction))
                    .await
                    .map_err(server_error)?
                    .unwrap_or(existing);
                info!(
                    "Found existing document with idempotency key `{idempotency_key}`, returning latest version"
                );
                transaction.rollback().await.map_err(server_error)?;
                return Ok(Json(DocumentUpdateResponse::FastForwardUpdate(
                    latest.into(),
                )));
            }
        }
    }

    let sanitized_relative_path = sanitize_path(&request.relative_path);

    if sanitized_relative_path.is_empty() {
        transaction.rollback().await.map_err(server_error)?;
        return Err(crate::errors::client_error(anyhow::anyhow!(
            "Relative path is empty after sanitization"
        )));
    }

    let new_content = request.content.contents.to_vec();

    let latest_version = state
        .database
        .get_latest_non_deleted_document_by_path(
            &vault_id,
            &sanitized_relative_path,
            Some(&mut *transaction),
        )
        .await
        .map_err(server_error)?;

    if let Some(latest_version) = latest_version {
        let is_mergeable_text = is_file_type_mergable(
            &sanitized_relative_path,
            &state.config.server.mergeable_file_extensions,
        ) && !is_binary(&latest_version.content)
            && !is_binary(&new_content);

        if is_mergeable_text || new_content == latest_version.content {
            return merge_with_stored_version(
                MergeInput {
                    parent_content: &[],
                    new_content,
                    idempotency_key: request.idempotency_key,
                },
                latest_version,
                vault_id,
                user,
                device_id,
                state,
                transaction,
            )
            .await;
        }

        // For non-mergeable (binary) files with different content, don't
        // merge — create a separate document at a deconflicted path so
        // neither client's data is silently overwritten.
    }

    // For creates at deconflicted paths (e.g., "file (2).bin"), the client's
    // ensureClearPath renamed a local file before uploading. Check if the
    // base path (e.g., "file.bin") has a document with identical content.
    // If so, merge with it instead of creating a duplicate document.
    let base_path = get_base_path(&sanitized_relative_path);
    if base_path != sanitized_relative_path {
        let base_doc = state
            .database
            .get_latest_non_deleted_document_by_path(&vault_id, &base_path, Some(&mut *transaction))
            .await
            .map_err(server_error)?;
        if let Some(base_doc) = base_doc
            && new_content == base_doc.content
        {
            info!(
                "Create at deconflicted path `{sanitized_relative_path}` has identical content to document at base path `{base_path}`, merging"
            );
            return merge_with_stored_version(
                MergeInput {
                    parent_content: &[],
                    new_content,
                    idempotency_key: request.idempotency_key,
                },
                base_doc,
                vault_id,
                user,
                device_id,
                state,
                transaction,
            )
            .await;
        }
    }

    let document_id = uuid::Uuid::new_v4();

    let last_update_id = state
        .database
        .get_max_update_id_in_vault(&vault_id, Some(&mut *transaction))
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
        content: new_content,
        updated_date: chrono::Utc::now(),
        is_deleted: false,
        user_id: user.name,
        device_id: device_id.0,
        has_been_merged: false,
        idempotency_key: request.idempotency_key,
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
