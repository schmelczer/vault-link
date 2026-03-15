use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, State},
};
use log::debug;
use serde::{Deserialize, Serialize};

use crate::{
    app_state::{AppState, database::models::VaultId},
    errors::{SyncServerError, server_error},
    utils::normalize::normalize,
};

#[derive(Deserialize)]
pub struct ResolveKeysPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveKeysRequest {
    pub idempotency_keys: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveKeysResponse {
    /// Maps `idempotency_key` -> `document_id` for keys that were found
    pub resolved: HashMap<String, String>,
}

#[axum::debug_handler]
pub async fn resolve_keys(
    Path(ResolveKeysPathParams { vault_id }): Path<ResolveKeysPathParams>,
    State(state): State<AppState>,
    Json(request): Json<ResolveKeysRequest>,
) -> Result<Json<ResolveKeysResponse>, SyncServerError> {
    debug!(
        "Resolving {} idempotency keys in vault `{vault_id}`",
        request.idempotency_keys.len()
    );

    let mut resolved = HashMap::new();

    for key in &request.idempotency_keys {
        let document = state
            .database
            .get_document_by_idempotency_key(&vault_id, key, None)
            .await
            .map_err(server_error)?;

        if let Some(doc) = document {
            resolved.insert(key.clone(), doc.document_id.to_string());
        }
    }

    debug!("Resolved {}/{} idempotency keys", resolved.len(), request.idempotency_keys.len());

    Ok(Json(ResolveKeysResponse { resolved }))
}
