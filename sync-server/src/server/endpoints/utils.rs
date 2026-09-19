use anyhow::anyhow;

use crate::{
    app_state::database::{
        Database, Transaction,
        models::{EventRecord, VaultEvent},
    },
    errors::{SyncServerError, client_error, server_error},
};

pub(super) async fn find_already_processed_event(
    tx: &mut Transaction<'_>,
    request_id: uuid::Uuid,
    fingerprint: &[u8],
) -> Result<Option<VaultEvent>, SyncServerError> {
    let Some((stored_fingerprint, event_json)) = Database::get_request_event(tx, request_id)
        .await
        .map_err(server_error)?
    else {
        return Ok(None);
    };

    if stored_fingerprint != fingerprint {
        return Err(client_error(anyhow!(
            "Request ID was reused with a different payload"
        )));
    }

    serde_json::from_str::<EventRecord>(&event_json)
        .map(|record| Some(record.event))
        .map_err(|error| server_error(error.into()))
}
