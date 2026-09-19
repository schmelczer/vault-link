use core::time::Duration;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context as _, Result};
use log::info;
use models::VaultId;
use sha2::{Digest, Sha256};
use sqlx::{ConnectOptions, sqlite::SqliteConnectOptions};
use sqlx::{Pool, Sqlite, sqlite::SqlitePoolOptions};
use tokio::sync::Mutex;
use tokio::time::Instant;

pub mod models;

mod mutations;
mod queries;

#[cfg(test)]
mod tests;

use crate::{
    config::database_config::DatabaseConfig,
    utils::normalize_vault_id::{normalize_string, validate_vault_id},
};

const VAULT_DATABASE_DIRECTORY: &str = "vaults";

#[derive(Clone)]
struct PoolWithTimestamp {
    pool: Pool<Sqlite>,
    last_accessed: Instant,
}

impl std::fmt::Debug for PoolWithTimestamp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PoolWithTimestamp")
            .field("pool", &"Pool<Sqlite>")
            .field("last_accessed", &self.last_accessed)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct Database {
    config: DatabaseConfig,
    connection_pools: Arc<Mutex<HashMap<VaultId, PoolWithTimestamp>>>,
}

pub type Transaction<'a> = sqlx::Transaction<'a, Sqlite>;

impl Database {
    pub async fn try_new(config: &DatabaseConfig) -> Result<Self> {
        let vault_directory = config
            .databases_directory_path
            .join(VAULT_DATABASE_DIRECTORY);
        tokio::fs::create_dir_all(&vault_directory)
            .await
            .with_context(|| {
                format!(
                    "Failed to create databases directory at `{}`",
                    config.databases_directory_path.to_string_lossy()
                )
            })?;

        info!("Applying pending database migrations");

        // Filenames encode only a digest, so their vault names cannot be
        // recovered here. Check migrations now and open pools lazily by name.
        let mut entries = tokio::fs::read_dir(&vault_directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_type().await?.is_file()
                && entry.path().extension().is_some_and(|ext| ext == "sqlite")
            {
                Self::open_database(config, &entry.path())
                    .await?
                    .close()
                    .await;
            }
        }

        let database = Self {
            config: config.clone(),
            connection_pools: Arc::default(),
        };

        // Start background task to cleanup idle connection pools
        database.start_idle_pool_cleanup();

        Ok(database)
    }

    fn database_path(config: &DatabaseConfig, vault: &str) -> PathBuf {
        // Hash the normalized vault name into a fixed-length ASCII filename so
        // filesystem case/Unicode aliasing (e.g. composed vs. decomposed é on
        // macOS) cannot make separately authorized vaults share a database.
        // This is only a storage filename; the user-facing vault name is unchanged.
        let digest = Sha256::digest(vault.as_bytes());
        config
            .databases_directory_path
            .join(VAULT_DATABASE_DIRECTORY)
            .join(format!("{digest:x}.sqlite"))
    }

    async fn open_database(config: &DatabaseConfig, file_name: &Path) -> Result<Pool<Sqlite>> {
        let connection_options = SqliteConnectOptions::new()
            .filename(file_name)
            .create_if_missing(true)
            .auto_vacuum(sqlx::sqlite::SqliteAutoVacuum::Full)
            .busy_timeout(Duration::from_secs(3600))
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Full)
            .pragma("fullfsync", "ON")
            .foreign_keys(true)
            .log_slow_statements(log::LevelFilter::Warn, Duration::from_secs(30));

        let pool = SqlitePoolOptions::new()
            .max_connections(config.max_connections_per_vault)
            .acquire_slow_threshold(Duration::from_secs(30))
            .test_before_acquire(true)
            .connect_with(connection_options)
            .await
            .with_context(|| format!("Cannot open database at `{}`", file_name.display()))?;

        Self::run_migrations(&pool).await?;

        Ok(pool)
    }

    async fn run_migrations(pool: &Pool<Sqlite>) -> Result<()> {
        sqlx::migrate!("src/app_state/database/migrations")
            .run(pool)
            .await
            .context("Cannot check for pending migrations")
    }

    async fn get_connection_pool(&self, vault: &VaultId) -> Result<Pool<Sqlite>> {
        let vault = normalize_string(vault);
        validate_vault_id(&vault)?;
        let mut pools = self.connection_pools.lock().await;

        if !pools.contains_key(&vault) {
            let file_name = Self::database_path(&self.config, &vault);
            let pool = Self::open_database(&self.config, &file_name).await?;
            pools.insert(
                vault.clone(),
                PoolWithTimestamp {
                    pool,
                    last_accessed: Instant::now(),
                },
            );
        }

        let pool_with_timestamp = pools
            .get_mut(&vault)
            .expect("Pool was just inserted or already exists");

        // Update last accessed time
        pool_with_timestamp.last_accessed = Instant::now();

        Ok(pool_with_timestamp.pool.clone())
    }

    /// Attempting to write from this transaction might result in a
    /// database locked error. Use this transaction for read-only operations.
    pub async fn create_readonly_transaction(
        &self,
        vault: &VaultId,
    ) -> Result<Transaction<'static>> {
        self.get_connection_pool(vault)
            .await?
            .begin()
            .await
            .context("Cannot create transaction")
    }

    pub async fn create_write_transaction(&self, vault: &VaultId) -> Result<Transaction<'static>> {
        self.get_connection_pool(vault)
            .await?
            .begin_with("BEGIN IMMEDIATE")
            .await
            .context("Cannot create write transaction")
    }

    /// Cleanup idle connection pools that haven't been accessed in more than 5 minutes
    async fn cleanup_idle_pools(&self) {
        let mut pools = self.connection_pools.lock().await;
        let now = Instant::now();
        let idle_timeout = Duration::from_secs(5 * 60); // 5 minutes

        // Collect vaults to remove
        let vaults_to_remove: Vec<VaultId> = pools
            .iter()
            .filter(|(_, pool_with_timestamp)| {
                now.duration_since(pool_with_timestamp.last_accessed) > idle_timeout
            })
            .map(|(vault_id, _)| vault_id.clone())
            .collect();

        // Close and remove idle pools
        for vault_id in &vaults_to_remove {
            if let Some(pool_with_timestamp) = pools.remove(vault_id) {
                info!("Closing idle database connection pool for vault `{vault_id}`");
                pool_with_timestamp.pool.close().await;
            }
        }
    }

    /// Start a background task that periodically cleans up idle connection pools
    fn start_idle_pool_cleanup(&self) {
        let database = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60)); // Check every minute
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;
                database.cleanup_idle_pools().await;
            }
        });
    }
}
