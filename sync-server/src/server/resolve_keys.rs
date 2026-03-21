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

    // Each key lookup is an independent read — no write transaction needed.
    // Using create_write_transaction (BEGIN IMMEDIATE) here would hold the
    // SQLite write lock for the entire iteration, blocking all concurrent
    // creates/updates/deletes and causing server-wide deadlocks under load.
    let mut resolved = HashMap::new();

    for key in &request.idempotency_keys {
        let document = state
            .database
            .get_document_by_idempotency_key(&vault_id, key, None)
            .await
            .map_err(server_error)?;

        if let Some(doc) = document {
            // Skip deleted documents — returning their documentId would cause
            // the client to assign a stale ID to its pending doc, and the
            // subsequent create retry would get a different documentId from the
            // server (since create_document falls through for deleted matches),
            // leaving the document permanently stuck.
            if !doc.is_deleted {
                resolved.insert(key.clone(), doc.document_id.to_string());
            }
        }
    }

    debug!(
        "Resolved {}/{} idempotency keys",
        resolved.len(),
        request.idempotency_keys.len()
    );

    Ok(Json(ResolveKeysResponse { resolved }))
}
