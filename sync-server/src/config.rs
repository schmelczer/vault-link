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
    pub users: UserConfig,
    #[serde(default)]
    pub logging: LoggingConfig,
}

impl Config {
    pub async fn read_or_create(path: &Path) -> Result<Self> {
        match Self::load_from_file(path).await {
            Ok(config) => return Ok(config),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) => {}
            Err(error) => return Err(error),
        }
        let contents = serde_yaml::to_string(&Self::default())?;
        let destination = path.to_owned();
        tokio::task::spawn_blocking(move || -> Result<()> {
            use std::io::Write;
            let path = destination;
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let temporary = parent.join(format!(".vault-link-config-{}.tmp", uuid::Uuid::new_v4()));
            let result = (|| -> Result<()> {
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&temporary)?;
                file.write_all(contents.as_bytes())?;
                file.sync_all()?;
                // Publish a complete, durable file without replacing a config
                // another process may have created while we generated defaults.
                match std::fs::hard_link(&temporary, &path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
                #[cfg(unix)]
                std::fs::File::open(parent)?.sync_all()?;
                Ok(())
            })();
            let _ = std::fs::remove_file(&temporary);
            result
        })
        .await??;
        info!("Loading configuration from `{}`", path.display());
        Self::load_from_file(path).await
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn startup_preserves_existing_configuration_bytes_and_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yml");
        let original = b"# administrator's comments and formatting\nserver: {port: 9123}\nusers: {user_configs: []}\n";
        fs::write(&path, original).await.unwrap();
        let mut permissions = fs::metadata(&path).await.unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).await.unwrap();
        let config = Config::read_or_create(&path).await.unwrap();
        assert_eq!(config.server.port, 9123);
        assert_eq!(fs::read(&path).await.unwrap(), original);
    }

    #[tokio::test]
    async fn existing_configuration_cannot_generate_unpersisted_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yml");
        for contents in ["server: {port: 9123}\n", "users: {}\n"] {
            fs::write(&path, contents).await.unwrap();
            for _ in 0..2 {
                assert!(
                    Config::read_or_create(&path).await.is_err(),
                    "Existing credentials must be explicit; random defaults are only for initialization"
                );
            }
            assert_eq!(fs::read_to_string(&path).await.unwrap(), contents);
        }
    }

    #[tokio::test]
    async fn concurrent_initialization_never_overwrites_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yml");
        let results =
            futures::future::join_all((0..16).map(|_| Config::read_or_create(&path))).await;
        let config = Config::load_from_file(&path).await.unwrap();
        for result in results {
            assert_eq!(
                serde_yaml::to_string(&result.unwrap()).unwrap(),
                serde_yaml::to_string(&config).unwrap()
            );
        }
    }
}
