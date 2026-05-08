use std::path::Path;

use anyhow::{Context as _, Result};
use database_config::DatabaseConfig;
use log::info;
use logging_config::LoggingConfig;
use serde::{Deserialize, Serialize};
use server_config::ServerConfig;
use tokio::fs;
use user_config::UserConfig;

pub mod database_config;
pub mod logging_config;
pub mod server_config;
pub mod user_config;

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct Config {
    #[serde(default)]
    pub database: DatabaseConfig,
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub users: UserConfig,
    #[serde(default)]
    pub logging: LoggingConfig,
}

impl Config {
    pub fn validate(&self) -> Result<()> {
        self.server
            .validate()
            .context("Invalid server configuration")?;
        self.logging
            .validate()
            .context("Invalid logging configuration")?;
        self.database
            .validate()
            .context("Invalid database configuration")?;
        Ok(())
    }

    pub async fn read_or_create(path: &Path) -> Result<Self> {
        let display_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

        if path.exists() {
            info!("Loading configuration from `{}`", display_path.display());
            Self::load_from_file(path).await
        } else {
            let config = Self::default();
            config.write(path).await?;
            info!(
                "Created default configuration at `{}`",
                display_path.display()
            );
            Ok(config)
        }
    }

    pub async fn load_from_file(path: &Path) -> Result<Self> {
        let contents = fs::read_to_string(path).await.with_context(|| {
            format!(
                "Cannot load configuration from disk from `{}`",
                path.display()
            )
        })?;

        serde_yaml::from_str(&contents).context("Failed to parse configuration")
    }

    pub async fn write(&self, path: &Path) -> Result<()> {
        let contents = serde_yaml::to_string(&self).context("Failed to serialize configuration")?;

        fs::write(path, contents)
            .await
            .context("Failed to write configuration to disk")
    }
}
