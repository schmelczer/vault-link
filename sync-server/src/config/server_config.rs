use log::debug;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::consts::{
    DEFAULT_HOST, DEFAULT_MAX_BODY_SIZE_MB, DEFAULT_MAX_CLIENTS_PER_VAULT,
    DEFAULT_MERGEABLE_FILE_EXTENSIONS, DEFAULT_PORT, DEFAULT_RESPONSE_TIMEOUT_SECONDS,
};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ServerConfig {
    #[serde(default = "default_host")]
    pub host: String,

    #[serde(default = "default_port")]
    pub port: u16,

    #[serde(default = "default_max_body_size_mb")]
    pub max_body_size_mb: usize,

    #[serde(default = "default_max_clients_per_vault")]
    pub max_clients_per_vault: usize,

    #[serde(default = "default_response_timeout", with = "humantime_serde")]
    pub response_timeout: Duration,

    #[serde(default = "default_mergeable_file_extensions")]
    pub mergeable_file_extensions: Vec<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
            max_body_size_mb: default_max_body_size_mb(),
            max_clients_per_vault: default_max_clients_per_vault(),
            response_timeout: default_response_timeout(),
            mergeable_file_extensions: default_mergeable_file_extensions(),
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[tokio::test]
    async fn fresh_and_omitted_server_configs_use_the_documented_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.yml");
        let fresh = Config::read_or_create(&path).await.unwrap();
        let reread = Config::load_from_file(&path).await.unwrap();
        let omitted: Config = serde_yaml::from_str("users: {user_configs: []}").unwrap();
        let explicit: Config =
            serde_yaml::from_str("server: {}\nusers: {user_configs: []}").unwrap();
        for config in [fresh, reread, omitted, explicit] {
            assert_eq!(config.server.host, DEFAULT_HOST);
            assert_eq!(config.server.port, DEFAULT_PORT);
            assert_eq!(config.server.max_body_size_mb, DEFAULT_MAX_BODY_SIZE_MB);
            assert_eq!(
                config.server.max_clients_per_vault,
                DEFAULT_MAX_CLIENTS_PER_VAULT
            );
            assert_eq!(
                config.server.response_timeout,
                DEFAULT_RESPONSE_TIMEOUT_SECONDS
            );
            assert_eq!(
                config.server.mergeable_file_extensions,
                DEFAULT_MERGEABLE_FILE_EXTENSIONS
            );
        }
    }
}
