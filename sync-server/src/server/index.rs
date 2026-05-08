use axum::{
    body::Body,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use log::warn;
use rust_embed::Embed;

use crate::app_state::AppState;

#[derive(Embed)]
#[folder = "../frontend/history-ui/dist/"]
struct HistoryUiAssets;

pub async fn index(State(_state): State<AppState>) -> impl IntoResponse {
    if let Some(content) = HistoryUiAssets::get("index.html") {
        Html(
            std::str::from_utf8(content.data.as_ref())
                .inspect_err(|e| warn!("Embedded index.html is not valid UTF-8: {e}"))
                .unwrap_or("<h1>VaultLink</h1>")
                .to_owned(),
        )
        .into_response()
    } else {
        warn!("No embedded index.html found — history UI may not have been built");
        Html("<h1>VaultLink server</h1>".to_owned()).into_response()
    }
}

pub async fn spa_assets(Path(path): Path<String>) -> impl IntoResponse {
    // The route is /assets/*path so path is relative to assets/.
    // The embedded files include the assets/ prefix from the dist directory.
    let full_path = format!("assets/{path}");
    if let Some(content) = HistoryUiAssets::get(&full_path) {
        let mime = mime_guess::from_path(&full_path).first_or_octet_stream();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(Body::from(content.data.to_vec()))
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::empty())
                    .unwrap_or_else(|_| Response::new(Body::empty()))
            });
    }

    // Asset paths must match an embedded file — no SPA fallback.
    // Serving index.html here would return 200 with text/html for missing
    // .css/.js files, causing the browser to silently ignore the content.
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("Not found"))
        .unwrap_or_else(|_| Response::new(Body::from("Not found")))
}

/// SPA fallback for production: serves index.html for client-side routes
/// (e.g. `/documents/123`).
pub async fn spa_fallback() -> impl IntoResponse {
    match HistoryUiAssets::get("index.html") {
        Some(content) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(content.data.to_vec()))
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::empty())
                    .unwrap_or_else(|_| Response::new(Body::empty()))
            }),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("Not found"))
            .unwrap_or_else(|_| Response::new(Body::from("Not found"))),
    }
}
