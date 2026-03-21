use axum::{
    Json,
    extract::{Path, Query, State},
};
use log::debug;
use serde::Deserialize;

use super::responses::VaultHistoryResponse;
use crate::{
    app_state::{
        AppState,
        database::models::{VaultId, VaultUpdateId},
    },
    errors::{SyncServerError, client_error, server_error},
    utils::normalize::normalize,
};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 500;

#[derive(Deserialize)]
pub struct FetchVaultHistoryPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
}

#[derive(Deserialize)]
pub struct QueryParams {
    limit: Option<i64>,
    before_update_id: Option<VaultUpdateId>,
}

#[axum::debug_handler]
pub async fn fetch_vault_history(
    Path(FetchVaultHistoryPathParams { vault_id }): Path<FetchVaultHistoryPathParams>,
    Query(QueryParams {
        limit,
        before_update_id,
    }): Query<QueryParams>,
    State(state): State<AppState>,
) -> Result<Json<VaultHistoryResponse>, SyncServerError> {
    if let Some(id) = before_update_id
        && id <= 0
    {
        return Err(client_error(anyhow::anyhow!(
            "before_update_id must be a positive integer"
        )));
    }

    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    debug!(
        "Fetching vault history for vault `{vault_id}` (limit={limit}, before={before_update_id:?})"
    );

    // Fetch one extra row to determine if there are more results
    let mut versions = state
        .database
        .get_vault_history(&vault_id, limit + 1, before_update_id, None)
        .await
        .map_err(server_error)?;

    #[allow(clippy::cast_sign_loss)] // limit is clamped to [1, 500] above
    let has_more = versions.len() > limit as usize;
    if has_more {
        versions.pop();
    }

    Ok(Json(VaultHistoryResponse { versions, has_more }))
}
