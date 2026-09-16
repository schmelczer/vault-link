use axum::{
    Json,
    extract::{Path, State},
};
use axum_extra::{
    TypedHeader,
    headers::{Authorization, authorization::Bearer},
};
use log::debug;
use serde::Deserialize;

use crate::server::{auth::auth, responses::PingResponse};
use crate::{
    app_state::{AppState, database::models::VaultId},
    consts::SUPPORTED_API_VERSION,
    errors::SyncServerError,
    utils::normalize::normalize,
};

#[derive(Deserialize)]
pub struct PingPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
}

#[axum::debug_handler]
pub async fn ping(
    maybe_auth_header: Option<TypedHeader<Authorization<Bearer>>>,
    Path(PingPathParams { vault_id }): Path<PingPathParams>,
    State(state): State<AppState>,
) -> Result<Json<PingResponse>, SyncServerError> {
    debug!("Pinging vault `{vault_id}`");

    let is_authenticated = maybe_auth_header
        .is_some_and(|auth_header| auth(&state, auth_header.token(), &vault_id).is_ok());

    Ok(Json(PingResponse {
        server_version: env!("CARGO_PKG_VERSION").to_owned(),
        is_authenticated,
        mergeable_file_extensions: state.config.server.mergeable_file_extensions.clone(),
        supported_api_version: SUPPORTED_API_VERSION,
    }))
}
