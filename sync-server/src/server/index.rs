use axum::response::{Html, IntoResponse};

pub async fn index() -> impl IntoResponse {
    const HTML_CONTENT: &str = include_str!("./assets/index.html");
    Html(HTML_CONTENT)
}
