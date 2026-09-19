use anyhow::anyhow;
use axum::{
    Json,
    extract::{Path, State},
};
use log::debug;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::utils::find_already_processed_event;
use crate::{
    app_state::{
        AppState,
        database::{
            Database,
            models::{EventRecord, FileManifest, VaultEvent, VaultId},
        },
    },
    errors::{SyncServerError, client_error, server_error},
    server::{requests::PushFileManifest, responses::FileManifestUpdateResponse},
    utils::normalize::normalize,
};

#[derive(Deserialize)]
pub struct PutFileManifestPath {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
}

#[axum::debug_handler]
pub async fn put_file_manifest(
    Path(path): Path<PutFileManifestPath>,
    State(state): State<AppState>,
    Json(push): Json<PushFileManifest>,
) -> Result<Json<FileManifestUpdateResponse>, SyncServerError> {
    debug!("Pushing file manifest for vault `{}`", path.vault_id);

    // BTreeMap canonicalizes file manifest entries for request fingerprinting.
    let fingerprint = Sha256::digest(
        serde_json::to_vec(&("file_manifest", &push))
            .map_err(|error| server_error(error.into()))?,
    );

    let mut tx = state
        .database
        .create_write_transaction(&path.vault_id)
        .await
        .map_err(server_error)?;

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

    let latest = Database::current_file_manifest(&mut tx)
        .await
        .map_err(server_error)?;

    if latest.file_manifest_id != push.parent_file_manifest_id {
        return Ok(Json(FileManifestUpdateResponse::StaleBase(latest)));
    }

    for id in push.entries.keys() {
        if state
            .database
            .get_latest_document_version(&path.vault_id, id, Some(&mut tx))
            .await
            .map_err(server_error)?
            .is_none()
        {
            return Err(client_error(anyhow!(
                "File manifest references missing content: {id}"
            )));
        }
    }

    let file_manifest = FileManifest {
        file_manifest_id: Database::allocate_event(&mut tx, push.request_id, &fingerprint)
            .await
            .map_err(server_error)?,
        entries: push.entries,
    };

    Database::insert_file_manifest(&mut tx, &file_manifest)
        .await
        .map_err(server_error)?;

    let response = FileManifestUpdateResponse::Accepted {
        file_manifest_id: file_manifest.file_manifest_id,
    };

    let event = EventRecord {
        event_id: file_manifest.file_manifest_id,
        request_id: push.request_id,
        event: VaultEvent::FileManifest { file_manifest },
    };

    Database::write_event(&mut tx, &event)
        .await
        .map_err(server_error)?;

    tx.commit()
        .await
        .map_err(|error| server_error(error.into()))?;

    state
        .broadcasts
        .notify_about_vault_update(path.vault_id)
        .await;

    Ok(Json(response))
}
