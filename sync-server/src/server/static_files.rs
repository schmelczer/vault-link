use axum::{
    extract::Path,
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../docs/.vitepress/dist"]
pub struct DocsAssets;

pub async fn serve_static_file(Path(path): Path<String>) -> Response {
    let path = if path.is_empty() { "index.html" } else { &path };

    match DocsAssets::get(path) {
        Some(content) => {
            let mime_type = mime_guess::from_path(path).first_or_octet_stream();
            let body = content.data.into_owned();

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime_type.as_ref())
                .header(header::CACHE_CONTROL, "public, max-age=3600")
                .body(body.into())
                .unwrap()
        }
        None => {
            // For SPA routing, if file not found, try serving index.html
            match DocsAssets::get("index.html") {
                Some(content) => {
                    Html(String::from_utf8_lossy(&content.data).to_string()).into_response()
                }
                None => (StatusCode::NOT_FOUND, "Documentation not found").into_response(),
            }
        }
    }
}

pub async fn serve_index() -> Response {
    match DocsAssets::get("index.html") {
        Some(content) => Html(String::from_utf8_lossy(&content.data).to_string())
            .into_response(),
        None => {
            Html(r"
                <html>
                    <head><title>VaultLink Server</title></head>
                    <body>
                        <h1>VaultLink Sync Server</h1>
                        <p>Documentation not available. The server was compiled without embedded docs.</p>
                    </body>
                </html>
            ").into_response()
        }
    }
}
