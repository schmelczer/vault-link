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

pub async fn index(State(state): State<AppState>) -> impl IntoResponse {
    if let Some(proxy_url) = &state.config.server.dev_proxy_url {
        let response = proxy_request(proxy_url, "/").await;
        if response.status().is_success() {
            return response;
        }
    }

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

pub async fn spa_assets(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    if let Some(proxy_url) = &state.config.server.dev_proxy_url {
        let response = proxy_request(proxy_url, &format!("/assets/{path}")).await;
        if response.status().is_success() {
            return response;
        }
    }

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

/// Proxies unmatched paths to the Vite dev server for HMR support
/// (`@vite/client`, `src/`, etc.).
pub async fn vite_proxy(
    State(state): State<AppState>,
    request: axum::extract::Request,
) -> impl IntoResponse {
    let proxy_url = state.config.server.dev_proxy_url.as_deref().unwrap_or("");
    let response = proxy_request(proxy_url, request.uri().path()).await;
    if !response.status().is_success() {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("Not found"))
            .unwrap_or_else(|_| Response::new(Body::from("Not found")));
    }
    response
}

/// SPA fallback for production: serves index.html for client-side routes
/// (e.g. `/documents/123`). Only used when the dev proxy is disabled.
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

static DEV_PROXY_CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default()
});

async fn proxy_request(proxy_url: &str, path: &str) -> Response {
    let url = format!("{proxy_url}{path}");
    match DEV_PROXY_CLIENT.get(&url).send().await {
        Ok(resp) => {
            let status =
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let mut builder = Response::builder().status(status);
            for (name, value) in resp.headers() {
                builder = builder.header(name.clone(), value.clone());
            }
            let bytes = resp.bytes().await.unwrap_or_default();
            builder.body(Body::from(bytes)).unwrap_or_else(|_| {
                Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Body::empty())
                    .unwrap_or_else(|_| Response::new(Body::empty()))
            })
        }
        Err(_) => {
            // Dev server not running — fall back to embedded assets
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::empty())
                .unwrap_or_else(|_| Response::new(Body::empty()))
        }
    }
}
