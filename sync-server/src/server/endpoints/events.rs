use axum::{
    Json,
    extract::{Path, Query, State},
};
use log::debug;
use serde::Deserialize;

use super::VaultPath;
use crate::{
    app_state::{AppState, database::models::EventBatch},
    errors::{SyncServerError, client_error, server_error},
};

#[derive(Deserialize)]
pub struct EventsQuery {
    pub after: i64,
}

#[axum::debug_handler]
pub async fn events(
    Path(VaultPath(vault_id)): Path<VaultPath>,
    Query(query): Query<EventsQuery>,
    State(state): State<AppState>,
) -> Result<Json<EventBatch>, SyncServerError> {
    debug!(
        "Fetching events after `{}` for vault `{}`",
        query.after, vault_id
    );

    if query.after < 0 {
        return Err(client_error(anyhow::anyhow!("Invalid event cursor")));
    }

    state
        .database
        .events_after(&vault_id, query.after)
        .await
        .map(Json)
        .map_err(server_error)
}
