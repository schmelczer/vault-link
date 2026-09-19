use anyhow::anyhow;
use axum::response::IntoResponse;

use crate::errors::client_error;

#[axum::debug_handler]
pub async fn method_not_allowed() -> impl IntoResponse {
    client_error(anyhow!("Method not allowed"))
}
