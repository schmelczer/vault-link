use anyhow::{Context as _, anyhow};
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use axum_extra::TypedHeader;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reconcile_text::{BuiltinTokenizer, EditedText, NumberOrText};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::server::{
    device_id_header::DeviceIdHeader,
    requests::{PushContent, PushDocument},
    responses::DocumentUpdateResponse,
};
use crate::{
    app_state::{
        AppState,
        database::{
            Database,
            models::{DocumentId, StoredDocumentVersion, VaultId},
        },
    },
    config::user_config::User,
    errors::{SyncServerError, client_error, not_found_error, server_error},
    utils::{
        find_first_available_path::find_first_available_path, normalize::normalize,
        sanitize_path::sanitize_path,
    },
};

#[derive(Deserialize)]
pub struct PushDocumentPath {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,

    document_id: DocumentId,
}

#[axum::debug_handler]
pub async fn push_document(
    Path(PushDocumentPath {
        vault_id,
        document_id,
    }): Path<PushDocumentPath>,
    Extension(user): Extension<User>,
    TypedHeader(device_id): TypedHeader<DeviceIdHeader>,
    State(state): State<AppState>,
    Json(push): Json<PushDocument>,
) -> Result<Json<DocumentUpdateResponse>, SyncServerError> {
    accept_push(
        &state.database,
        &vault_id,
        document_id,
        user.name,
        device_id.0,
        push,
    )
    .await
    .map(Json)
}

/// A push is a compare-and-swap of one document's immutable head. The write lock
/// covers idempotency lookup, base validation, path allocation, and the commit.
async fn accept_push(
    database: &Database,
    vault_id: &VaultId,
    document_id: DocumentId,
    user_id: String,
    device_id: String,
    push: PushDocument,
) -> Result<DocumentUpdateResponse, SyncServerError> {
    let fingerprint = fingerprint(document_id, &push);

    let mut transaction = database
        .create_write_transaction(vault_id)
        .await
        .map_err(server_error)?;

    if let Some((stored_fingerprint, acknowledged)) = database
        .get_push_acknowledgement(vault_id, push.request_id, &mut transaction)
        .await
        .map_err(server_error)?
    {
        if stored_fingerprint != fingerprint {
            return Err(client_error(anyhow!(
                "Request ID was reused with a different payload"
            )));
        }
        return Ok(DocumentUpdateResponse::Accepted(acknowledged.into()));
    }

    let latest = database
        .get_latest_document(vault_id, &document_id, Some(&mut transaction))
        .await
        .map_err(server_error)?;

    match &latest {
        Some(latest)
            if latest.is_deleted || Some(latest.vault_update_id) != push.parent_version_id =>
        {
            return Ok(DocumentUpdateResponse::StaleBase(latest.clone().into()));
        }

        None if push.parent_version_id.is_some() => {
            return Err(not_found_error(anyhow!(
                "Document with id `{document_id}` not found"
            )));
        }

        _ => {}
    }

    let is_deleted = matches!(&push.content, PushContent::Delete);
    let (content, requested_path) = match push.content {
        PushContent::Snapshot(content) => (
            STANDARD
                .decode(content)
                .context("Invalid base64 snapshot")
                .map_err(client_error)?,
            sanitize_path(&push.relative_path),
        ),
        PushContent::Diff(diff) => (
            reconstruct_diff(latest.as_ref(), diff)?,
            sanitize_path(&push.relative_path),
        ),
        PushContent::Delete => {
            let latest = latest
                .as_ref()
                .ok_or_else(|| client_error(anyhow!("Cannot delete a missing document")))?;
            (latest.content.clone(), latest.relative_path.clone())
        }
    };

    let relative_path = if latest
        .as_ref()
        .is_some_and(|version| version.relative_path == requested_path)
    {
        requested_path
    } else {
        find_first_available_path(vault_id, &requested_path, database, &mut transaction)
            .await
            .map_err(server_error)?
    };

    let new_version = StoredDocumentVersion {
        vault_update_id: database
            .get_max_update_id_in_vault(vault_id, Some(&mut transaction))
            .await
            .map_err(server_error)?
            + 1,
        document_id,
        relative_path,
        content,
        updated_date: chrono::Utc::now(),
        is_deleted,
        user_id,
        device_id,
    };

    database
        .insert_document_version(
            vault_id,
            &new_version,
            push.request_id,
            &fingerprint,
            transaction,
        )
        .await
        .map_err(server_error)?;
    Ok(DocumentUpdateResponse::Accepted(new_version.into()))
}

fn reconstruct_diff(
    parent: Option<&StoredDocumentVersion>,
    diff: Vec<NumberOrText>,
) -> Result<Vec<u8>, SyncServerError> {
    // reconcile-text 0.8 negates deletion lengths; i64::MIN would overflow.
    if diff
        .iter()
        .any(|item| matches!(item, NumberOrText::Number(i64::MIN)))
    {
        return Err(client_error(anyhow!("Invalid diff length")));
    }
    let parent = parent.ok_or_else(|| client_error(anyhow!("A diff requires a parent version")))?;
    let parent_text = str::from_utf8(&parent.content)
        .context("Parent is not UTF-8 text")
        .map_err(client_error)?;
    // Transport decoding only: reconciliation belongs exclusively to clients.
    Ok(
        EditedText::from_diff(parent_text, diff, &*BuiltinTokenizer::Word)
            .context("Failed to apply diff to parent document")
            .map_err(client_error)?
            .apply()
            .text()
            .into_bytes(),
    )
}

/// Session/device IDs may change across retries; the requested mutation may not.
fn fingerprint(document_id: DocumentId, push: &PushDocument) -> Vec<u8> {
    Sha256::digest(
        serde_json::to_vec(&(document_id, push)).expect("Document pushes are serializable"),
    )
    .to_vec()
}

#[cfg(test)]
mod tests;
