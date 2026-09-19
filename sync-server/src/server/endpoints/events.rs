use axum::{
    Json,
    extract::{Path, Query, State},
};
use log::debug;
use serde::Deserialize;

use crate::{
    app_state::{
        AppState,
        database::models::{EventBatch, VaultId},
    },
    errors::{SyncServerError, client_error, server_error},
    utils::normalize::normalize,
};

#[derive(Deserialize)]
pub struct EventsPath {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
}

#[derive(Deserialize)]
pub struct EventsQuery {
    pub after: i64,
}

#[axum::debug_handler]
pub async fn events(
    Path(path): Path<EventsPath>,
    Query(query): Query<EventsQuery>,
    State(state): State<AppState>,
) -> Result<Json<EventBatch>, SyncServerError> {
    debug!(
        "Fetching events after `{}` for vault `{}`",
        query.after, path.vault_id
    );

    if query.after < 0 {
        return Err(client_error(anyhow::anyhow!("Invalid event cursor")));
    }

    state
        .database
        .events_after(&path.vault_id, query.after)
        .await
        .map(Json)
        .map_err(server_error)
}
