use anyhow::anyhow;
use axum::{
    Json,
    extract::{Path, State},
};
use log::debug;

use super::{
    VaultPath,
    utils::{commit_and_notify, find_already_processed_event, fingerprint_request},
};
use crate::{
    app_state::{
        AppState,
        database::{
            Database,
            models::{FileManifest, VaultEvent},
        },
    },
    errors::{SyncServerError, client_error},
    server::{requests::PushFileManifest, responses::FileManifestUpdateResponse},
};

#[axum::debug_handler]
pub async fn put_file_manifest(
    Path(VaultPath(vault_id)): Path<VaultPath>,
    State(state): State<AppState>,
    Json(push): Json<PushFileManifest>,
) -> Result<Json<FileManifestUpdateResponse>, SyncServerError> {
    debug!("Pushing file manifest for vault `{vault_id}`");

    // BTreeMap canonicalizes file manifest entries for request fingerprinting.
    let fingerprint = fingerprint_request(&("file_manifest", &push))?;

    let mut tx = state.database.create_write_transaction(&vault_id).await?;

    if let Some(event) =
        find_already_processed_event(&mut tx, push.request_id, &fingerprint).await?
    {
        return match event {
            VaultEvent::FileManifest { file_manifest } => {
                Ok(Json(FileManifestUpdateResponse::Accepted {
                    file_manifest_id: file_manifest.file_manifest_id,
                }))
            }
            VaultEvent::Content { .. } => Err(client_error(anyhow!(
                "Stored event does not match file manifest request"
            ))),
        };
    }

    let latest = Database::get_current_file_manifest(&mut tx).await?;

    if latest.file_manifest_id != push.parent_file_manifest_id {
        return Ok(Json(FileManifestUpdateResponse::StaleBase(latest)));
    }

    if let Some(id) =
        Database::get_missing_document(&mut tx, &push.entries.keys().copied().collect::<Vec<_>>())
            .await?
    {
        return Err(client_error(anyhow!(
            "File manifest references missing content: {id}"
        )));
    }

    let file_manifest = FileManifest {
        file_manifest_id: Database::allocate_event(&mut tx, push.request_id, &fingerprint).await?,
        entries: push.entries,
    };

    Database::insert_file_manifest(&mut tx, &file_manifest).await?;

    let response = FileManifestUpdateResponse::Accepted {
        file_manifest_id: file_manifest.file_manifest_id,
    };

    commit_and_notify(tx, &state, vault_id).await?;

    Ok(Json(response))
}
