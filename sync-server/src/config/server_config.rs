use anyhow::{Result, ensure};
use log::debug;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::consts::{
    DEFAULT_ALLOWED_ORIGINS, DEFAULT_BROADCAST_CHANNEL_CAPACITY, DEFAULT_HOST,
    DEFAULT_MAX_BODY_SIZE_MB, DEFAULT_MAX_CLIENTS_PER_VAULT, DEFAULT_MAX_PENDING_WS_CONNECTIONS,
    DEFAULT_MERGEABLE_FILE_EXTENSIONS, DEFAULT_PORT, DEFAULT_RATE_LIMIT_PER_USER_PER_SECOND,
    DEFAULT_RESPONSE_TIMEOUT_SECONDS, DURATION_ZERO,
};

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct ServerConfig {
    #[serde(default = "default_host")]
    pub host: String,

    #[serde(default = "default_port")]
    pub port: u16,

    #[serde(default = "default_max_body_size_mb")]
    pub max_body_size_mb: usize,

    #[serde(default = "default_max_clients_per_vault")]
    pub max_clients_per_vault: usize,

    #[serde(default = "default_broadcast_channel_capacity")]
    pub broadcast_channel_capacity: usize,

    #[serde(default = "default_response_timeout", with = "humantime_serde")]
    pub response_timeout: Duration,

    #[serde(default = "default_mergeable_file_extensions")]
    pub mergeable_file_extensions: Vec<String>,

    /// Per-user maximum requests per second (keyed by bearer token).
    /// `None` disables rate limiting.
    #[serde(default = "default_rate_limit_per_user_per_second")]
    pub rate_limit_per_user_per_second: Option<u64>,

    /// Allowed CORS origins. Default: `["*"]` (allow all).
    #[serde(default = "default_allowed_origins")]
    pub allowed_origins: Vec<String>,

    /// Maximum concurrent unauthenticated WebSocket connections waiting for
    /// handshake. Limits resource consumption from clients that connect but
    /// never authenticate.
    #[serde(default = "default_max_pending_websocket_connections")]
    pub max_pending_websocket_connections: usize,
}

impl ServerConfig {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.response_timeout > DURATION_ZERO,
            "response_timeout must be greater than 0"
        );
        ensure!(
            self.max_body_size_mb > 0,
            "max_body_size_mb must be greater than 0"
        );
        ensure!(
            self.max_clients_per_vault > 0,
            "max_clients_per_vault must be greater than 0"
        );
        ensure!(
            self.broadcast_channel_capacity > 0,
            "broadcast_channel_capacity must be greater than 0"
        );
        ensure!(
            self.max_pending_websocket_connections > 0,
            "max_pending_websocket_connections must be greater than 0"
        );

        Ok(())
    }
}

fn default_host() -> String {
    debug!("Using default server host: {DEFAULT_HOST}");
    DEFAULT_HOST.to_owned()
}

fn default_port() -> u16 {
    debug!("Using default server port: {DEFAULT_PORT}");
    DEFAULT_PORT
}

fn default_max_body_size_mb() -> usize {
    debug!("Using default max body size {DEFAULT_MAX_BODY_SIZE_MB} MB");
    DEFAULT_MAX_BODY_SIZE_MB
}

fn default_max_clients_per_vault() -> usize {
    debug!("Using default max clients per vault: {DEFAULT_MAX_CLIENTS_PER_VAULT}");
    DEFAULT_MAX_CLIENTS_PER_VAULT
}

fn default_broadcast_channel_capacity() -> usize {
    debug!("Using default broadcast channel capacity: {DEFAULT_BROADCAST_CHANNEL_CAPACITY}");
    DEFAULT_BROADCAST_CHANNEL_CAPACITY
}

fn default_response_timeout() -> Duration {
    debug!("Using default response timeout: {DEFAULT_RESPONSE_TIMEOUT_SECONDS:?}");
    DEFAULT_RESPONSE_TIMEOUT_SECONDS
}

fn default_mergeable_file_extensions() -> Vec<String> {
    debug!("Using default mergeable file extensions: {DEFAULT_MERGEABLE_FILE_EXTENSIONS:?}");
    DEFAULT_MERGEABLE_FILE_EXTENSIONS
        .iter()
        .map(|s| (*s).to_owned())
        .collect()
}

fn default_rate_limit_per_user_per_second() -> Option<u64> {
    debug!("Using default rate limit per second: {DEFAULT_RATE_LIMIT_PER_USER_PER_SECOND:?}");
    DEFAULT_RATE_LIMIT_PER_USER_PER_SECOND
}

fn default_allowed_origins() -> Vec<String> {
    debug!("Using default allowed origins: {DEFAULT_ALLOWED_ORIGINS:?}");
    DEFAULT_ALLOWED_ORIGINS
        .iter()
        .map(|s| (*s).to_owned())
        .collect()
}

fn default_max_pending_websocket_connections() -> usize {
    debug!("Using default max pending WebSocket connections: {DEFAULT_MAX_PENDING_WS_CONNECTIONS}");
    DEFAULT_MAX_PENDING_WS_CONNECTIONS
}
