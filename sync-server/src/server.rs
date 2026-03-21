pub mod auth;
mod create_document;
mod delete_document;
mod device_id_header;
mod fetch_document_version;
mod fetch_document_version_content;
mod fetch_document_versions;
mod fetch_latest_document_version;
mod fetch_latest_documents;
mod fetch_vault_history;
mod index;
mod ping;
mod rate_limit;
mod requests;
mod resolve_keys;
mod responses;
mod restore_document_version;
mod update_document;
mod websocket;

use anyhow::{Context as _, Result};
use auth::auth_middleware;
use axum::{
    Router,
    extract::{DefaultBodyLimit, Request},
    http::{self, HeaderValue, Method},
    middleware,
    routing::{IntoMakeService, delete, get, post, put},
};
use device_id_header::DEVICE_ID_HEADER_NAME;
use log::{info, warn};
use tokio::signal;
use tower_http::{
    LatencyUnit,
    cors::CorsLayer,
    limit::RequestBodyLimitLayer,
    timeout::TimeoutLayer,
    trace::{
        DefaultOnBodyChunk, DefaultOnEos, DefaultOnFailure, DefaultOnRequest, DefaultOnResponse,
        TraceLayer,
    },
};
use tracing::{Level, info_span};

use crate::{
    app_state::AppState,
    config::{Config, server_config::ServerConfig},
    consts::GRACEFUL_SHUTDOWN_TIMEOUT,
};

pub async fn create_server(config: Config) -> Result<()> {
    let app_state = AppState::try_new(config)
        .await
        .context("Failed to initialise app state")?;

    let server_config = app_state.config.server.clone();

    let mut app = Router::new()
        .nest("/", get_authed_routes(app_state.clone()))
        .route("/", get(index::index))
        .route("/assets/*path", get(index::spa_assets))
        .route("/vaults/:vault_id/ping", get(ping::ping))
        .route("/vaults/:vault_id/ws", get(websocket::websocket_handler));

    if app_state.config.server.dev_proxy_url.is_some() {
        info!(
            "Dev proxy enabled → {}",
            app_state.config.server.dev_proxy_url.as_deref().unwrap()
        );
        app = app.fallback(index::vite_proxy);
    }

    let cors_layer = build_cors_layer(&server_config).context("Invalid CORS configuration")?;

    if server_config.rate_limit_per_second > 0 {
        info!(
            "Rate limiting enabled: {} requests/second",
            server_config.rate_limit_per_second
        );
        let limiter = rate_limit::RateLimiter::new(server_config.rate_limit_per_second);
        app = app.layer(middleware::from_fn_with_state(
            limiter,
            rate_limit::rate_limit_middleware,
        ));
    }

    let app = app
        .layer(DefaultBodyLimit::disable())
        .layer(RequestBodyLimitLayer::new(
            app_state.config.server.max_body_size_mb * 1024 * 1024,
        ))
        .layer(TimeoutLayer::new(server_config.response_timeout))
        .layer(cors_layer)
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &Request<_>| {
                    info_span!(
                        "http",
                        method = ?request.method(),
                        uri = ?request.uri(),
                    )
                })
                .on_request(DefaultOnRequest::new().level(Level::INFO))
                .on_response(
                    DefaultOnResponse::new()
                        .level(Level::INFO)
                        .latency_unit(LatencyUnit::Millis),
                )
                .on_body_chunk(DefaultOnBodyChunk::new())
                .on_eos(DefaultOnEos::new())
                .on_failure(DefaultOnFailure::new().level(Level::ERROR)),
        )
        .with_state(app_state)
        .into_make_service();

    start_server(app, &server_config).await
}

fn build_cors_layer(server_config: &ServerConfig) -> Result<CorsLayer> {
    let origins = &server_config.allowed_origins;

    let cors = if origins.len() == 1 && origins[0] == "*" {
        info!("CORS: allowing all origins (wildcard)");
        let header: HeaderValue = "*"
            .parse()
            .context("Failed to parse wildcard CORS origin")?;
        CorsLayer::new().allow_origin(header)
    } else {
        let parsed: Vec<HeaderValue> = origins
            .iter()
            .map(|o| {
                o.parse::<HeaderValue>()
                    .with_context(|| format!("Failed to parse CORS origin: `{o}`"))
            })
            .collect::<Result<Vec<_>>>()?;
        CorsLayer::new().allow_origin(parsed)
    };

    Ok(cors
        .allow_headers([
            http::header::CONTENT_TYPE,
            http::header::AUTHORIZATION,
            DEVICE_ID_HEADER_NAME.clone(),
        ])
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE]))
}

fn get_authed_routes(app_state: AppState) -> Router<AppState> {
    Router::new()
        .route(
            "/vaults/:vault_id/documents",
            get(fetch_latest_documents::fetch_latest_documents),
        )
        .route(
            "/vaults/:vault_id/documents",
            post(create_document::create_document),
        )
        .route(
            "/vaults/:vault_id/documents/resolve-keys",
            post(resolve_keys::resolve_keys),
        )
        .route(
            "/vaults/:vault_id/documents/:document_id",
            get(fetch_latest_document_version::fetch_latest_document_version),
        )
        .route(
            "/vaults/:vault_id/documents/:document_id/binary",
            put(update_document::update_binary),
        )
        .route(
            "/vaults/:vault_id/documents/:document_id/text",
            put(update_document::update_text),
        )
        .route(
            "/vaults/:vault_id/documents/:document_id/versions",
            get(fetch_document_versions::fetch_document_versions),
        )
        .route(
            "/vaults/:vault_id/documents/:document_id/versions/:vault_update_id",
            get(fetch_document_version::fetch_document_version),
        )
        .route(
            "/vaults/:vault_id/documents/:document_id/versions/:vault_update_id/content",
            get(fetch_document_version_content::fetch_document_version_content),
        )
        .route(
            "/vaults/:vault_id/documents/:document_id",
            delete(delete_document::delete_document),
        )
        .route(
            "/vaults/:vault_id/documents/:document_id/restore",
            post(restore_document_version::restore_document_version),
        )
        .route(
            "/vaults/:vault_id/history",
            get(fetch_vault_history::fetch_vault_history),
        )
        .layer(middleware::from_fn_with_state(app_state, auth_middleware))
}

async fn start_server(app: IntoMakeService<axum::Router>, config: &ServerConfig) -> Result<()> {
    let address = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(address.clone())
        .await
        .with_context(|| format!("Failed to bind to address: {address}"))?;

    info!(
        "Listening on http://{}",
        listener
            .local_addr()
            .context("Failed to get local address")?
    );

    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);

    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            let _ = shutdown_tx.send(true);
        })
        .tcp_nodelay(true);

    tokio::select! {
        result = server => result.context("Failed to start server"),
        () = async {
            let _ = shutdown_rx.changed().await;
            info!(
                "Shutdown signal received, waiting up to {}s for in-flight requests to complete...",
                GRACEFUL_SHUTDOWN_TIMEOUT.as_secs()
            );
            tokio::time::sleep(GRACEFUL_SHUTDOWN_TIMEOUT).await;
            warn!("Graceful shutdown timed out, forcing exit");
        } => Ok(()),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = signal::ctrl_c().await {
            log::error!("Failed to install Ctrl+C handler: {e}");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(e) => {
                log::error!("Failed to install SIGTERM handler: {e}");
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
