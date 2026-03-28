use axum::{
    Json,
    extract::{Query, State},
};
use axum_extra::{
    TypedHeader,
    headers::{Authorization, authorization::Bearer},
};
use log::debug;
use serde::Deserialize;

use super::{
    auth::authenticate,
    responses::{ListVaultsResponse, VaultInfo},
};
use crate::{
    app_state::AppState,
    config::user_config::{AllowListedVaults, VaultAccess},
    errors::{SyncServerError, server_error, unauthenticated_error},
};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

#[derive(Deserialize)]
pub struct QueryParams {
    limit: Option<usize>,
    after: Option<String>,
}

#[axum::debug_handler]
pub async fn list_vaults(
    auth_header: Option<TypedHeader<Authorization<Bearer>>>,
    Query(QueryParams { limit, after }): Query<QueryParams>,
    State(state): State<AppState>,
) -> Result<Json<ListVaultsResponse>, SyncServerError> {
    let auth_header = auth_header
        .ok_or_else(|| unauthenticated_error(anyhow::anyhow!("Missing Authorization header")))?;

    let user = authenticate(&state, auth_header.token().trim())?;

    debug!("User `{}` listing accessible vaults", user.name);

    let existing_vaults = state.database.list_vaults().await.map_err(server_error)?;

    let mut accessible: Vec<String> = match user.vault_access {
        VaultAccess::AllowAccessToAll => existing_vaults,
        VaultAccess::AllowList(AllowListedVaults { ref allowed }) => existing_vaults
            .into_iter()
            .filter(|v| allowed.contains(v))
            .collect(),
    };

    // Cursor-based pagination: skip vaults up to and including `after`
    if let Some(ref cursor) = after {
        accessible.retain(|v| v.as_str() > cursor.as_str());
    }

    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let has_more = accessible.len() > limit;
    accessible.truncate(limit);

    let mut vaults = Vec::with_capacity(accessible.len());
    for name in accessible {
        let stats = state
            .database
            .get_vault_stats(&name)
            .await
            .map_err(server_error)?;
        vaults.push(VaultInfo {
            name,
            document_count: stats.document_count,
            created_at: stats.created_at,
        });
    }

    Ok(Json(ListVaultsResponse {
        vaults,
        has_more,
        user_name: user.name,
    }))
}
