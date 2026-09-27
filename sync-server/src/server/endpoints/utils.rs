use anyhow::anyhow;

use crate::{
    app_state::{
        AppState,
        database::{
            Database, Transaction,
            models::{VaultEvent, VaultId},
        },
    },
    errors::{SyncServerError, client_error, server_error},
};
use sha2::{Digest, Sha256};

pub(super) async fn find_already_processed_event(
    tx: &mut Transaction<'_>,
    request_id: uuid::Uuid,
    fingerprint: &[u8],
) -> Result<Option<VaultEvent>, SyncServerError> {
    let Some((stored_fingerprint, event)) = Database::get_request_event(tx, request_id).await?
    else {
        return Ok(None);
    };

    if stored_fingerprint != fingerprint {
        return Err(client_error(anyhow!(
            "Request ID was reused with a different payload"
        )));
    }

    Ok(Some(event))
}

/// Hash the canonical wire payload, including the operation and document ID.
pub(super) fn fingerprint_request(
    payload: &impl serde::Serialize,
) -> Result<[u8; 32], SyncServerError> {
    let encoded = serde_json::to_vec(payload).map_err(|error| server_error(error.into()))?;
    Ok(Sha256::digest(encoded).into())
}

/// Never advertise a write before its event and data are durably committed.
pub(super) async fn commit_and_notify(
    tx: Transaction<'_>,
    state: &AppState,
    vault: VaultId,
) -> Result<(), SyncServerError> {
    tx.commit().await?;

    state.broadcasts.notify_about_vault_update(vault).await;

    Ok(())
}
