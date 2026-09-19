use anyhow::anyhow;
use axum::response::IntoResponse;

use crate::errors::not_found_error;

#[axum::debug_handler]
pub async fn not_found() -> impl IntoResponse {
    not_found_error(anyhow!("Page not found"))
}
