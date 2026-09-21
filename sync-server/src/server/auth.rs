use std::collections::HashMap;

use axum::{
    extract::{Path, Request, State},
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_extra::{
    TypedHeader,
    headers::{Authorization, authorization::Bearer},
};
use log::info;

use crate::{
    app_state::{AppState, database::models::VaultId},
    config::user_config::{AllowListedVaults, User, VaultAccess},
    errors::{
        SyncServerError, client_error, permission_denied_error, server_error, unauthenticated_error,
    },
    utils::normalize_vault_id::{normalize_string, validate_vault_id},
};

pub async fn auth_middleware(
    State(state): State<AppState>,
    Path(path_params): Path<HashMap<String, String>>,
    TypedHeader(auth_header): TypedHeader<Authorization<Bearer>>,
    mut req: Request,
    next: Next,
) -> Result<Response, SyncServerError> {
    let token = auth_header.token().trim();
    let vault_id = normalize_string(
        path_params
            .get("vault_id")
            .ok_or_else(|| unauthenticated_error(anyhow::anyhow!("Missing vault_id")))?,
    );

    let user = auth(&state, token, &vault_id)?;

    // A restore happens while the server is stopped. Validate before executing
    // any old request, including retries whose numeric parent IDs were reused.
    if let Some(checkpoint) = req.headers().get("x-vault-link-history") {
        let checkpoint = checkpoint
            .to_str()
            .map_err(|error| client_error(error.into()))?;
        if !state
            .database
            .contains_checkpoint(&vault_id, checkpoint)
            .await
            .map_err(server_error)?
        {
            let mut response = (StatusCode::CONFLICT, "Server history changed").into_response();
            response.headers_mut().insert(
                "x-vault-link-history-mismatch",
                HeaderValue::from_static("1"),
            );
            return Ok(response);
        }
    }

    req.extensions_mut().insert(user);

    let mut response = next.run(req).await;
    if response.status().is_success() {
        let checkpoint = state
            .database
            .history_checkpoint(&vault_id)
            .await
            .map_err(server_error)?;
        response.headers_mut().insert(
            "x-vault-link-history",
            HeaderValue::from_str(&checkpoint).map_err(|error| server_error(error.into()))?,
        );
    }
    Ok(response)
}

pub fn auth(state: &AppState, token: &str, vault_id: &VaultId) -> Result<User, SyncServerError> {
    validate_vault_id(vault_id).map_err(client_error)?;
    let user = state
        .config
        .users
        .get_user(token)
        .cloned()
        .ok_or_else(|| unauthenticated_error(anyhow::anyhow!("Invalid token")))?;

    if match user.vault_access {
        VaultAccess::AllowAccessToAll => true,
        VaultAccess::AllowList(AllowListedVaults { ref allowed }) => allowed.contains(vault_id),
    } {
        info!(
            "User `{}` is authenticated and is authorised to access to vault `{vault_id}`",
            user.name
        );

        Ok(user)
    } else {
        info!(
            "User `{}` is authenticated but is not authorised to access vault `{vault_id}`",
            user.name
        );

        Err(permission_denied_error(anyhow::anyhow!(
            "Permission denied for vault `{vault_id}`"
        )))
    }
}
