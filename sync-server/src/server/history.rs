use crate::consts::{HISTORY_HEADER, HISTORY_MISMATCH_HEADER};
use std::collections::HashMap;

use axum::{
    extract::{Path, Request, State},
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::{
    app_state::{AppState, database::models::VaultId},
    errors::{SyncServerError, client_error, server_error},
    utils::normalize_vault_id::normalize_string,
};

pub async fn history_middleware(
    State(state): State<AppState>,
    Path(path_params): Path<HashMap<String, String>>,
    req: Request,
    next: Next,
) -> Result<Response, SyncServerError> {
    let vault_id: VaultId = normalize_string(
        path_params
            .get("vault_id")
            .ok_or_else(|| client_error(anyhow::anyhow!("Missing vault_id")))?,
    );

    // A restore happens while the server is stopped. Validate before executing
    // any old request, including retries whose numeric parent IDs were reused.
    if let Some(checkpoint) = req.headers().get(HISTORY_HEADER) {
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
            response
                .headers_mut()
                .insert(HISTORY_MISMATCH_HEADER, HeaderValue::from_static("1"));
            return Ok(response);
        }
    }

    let mut response = next.run(req).await;
    if response.status().is_success() {
        let checkpoint = state
            .database
            .get_history_checkpoint(&vault_id)
            .await
            .map_err(server_error)?;
        response.headers_mut().insert(
            HISTORY_HEADER,
            HeaderValue::from_str(&checkpoint).map_err(|error| server_error(error.into()))?,
        );
    }
    Ok(response)
}
