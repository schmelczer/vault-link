use core::time::Duration;
use std::{collections::HashMap, sync::Arc};

use anyhow::{Context as _, Result};
use log::info;
use models::{
    DocumentId, DocumentVersionWithoutContent, StoredDocumentVersion, VaultId, VaultUpdateId,
};
use sqlx::{ConnectOptions, Connection, sqlite::SqliteConnectOptions, types::chrono::Utc};

pub mod models;
use sqlx::{
    Pool, Sqlite, pool::PoolConnection, sqlite::SqliteConnection, sqlite::SqlitePoolOptions,
};
use tokio::sync::{Mutex, OnceCell};
use tokio::time::Instant;
use uuid::fmt::Hyphenated;

/// Row struct for vault history queries (used by `sqlx::query_as!`)
#[derive(Debug)]
struct VaultHistoryRow {
    vault_update_id: models::VaultUpdateId,
    document_id: models::DocumentId,
    relative_path: String,
    updated_date: chrono::DateTime<chrono::Utc>,
    is_deleted: bool,
    user_id: String,
    device_id: String,
    content_size: Option<u64>,
}

use super::websocket::{
    broadcasts::Broadcasts,
    models::{WebSocketServerMessage, WebSocketServerMessageWithOrigin, WebSocketVaultUpdate},
};
use crate::config::database_config::DatabaseConfig;
use crate::consts::IDLE_POOL_TIMEOUT;

#[derive(Debug)]
struct VaultPool {
    cell: Arc<OnceCell<Pool<Sqlite>>>,
    last_accessed: Mutex<Instant>,
}

#[derive(Clone, Debug)]
pub struct Database {
    config: DatabaseConfig,
    broadcasts: Broadcasts,
    connection_pools: Arc<Mutex<HashMap<VaultId, Arc<VaultPool>>>>,
}

/// A write transaction backed by a raw `BEGIN IMMEDIATE` instead of sqlx's
/// savepoint-based `Transaction`. This avoids the savepoint mismatch caused
/// by the old `END; BEGIN IMMEDIATE;` workaround.
pub struct WriteTransaction {
    conn: Option<PoolConnection<Sqlite>>,
}

impl WriteTransaction {
    async fn new(pool: &Pool<Sqlite>) -> Result<Self> {
        let mut conn = pool
            .acquire()
            .await
            .context("Cannot acquire connection for write transaction")?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .context("Cannot begin immediate transaction")?;
        Ok(Self { conn: Some(conn) })
    }

    pub async fn commit(mut self) -> Result<()> {
        if let Some(mut conn) = self.conn.take() {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .context("Failed to commit transaction")?;
        }
        Ok(())
    }

    pub async fn rollback(mut self) -> Result<()> {
        if let Some(mut conn) = self.conn.take() {
            sqlx::query("ROLLBACK")
                .execute(&mut *conn)
                .await
                .context("Failed to rollback transaction")?;
        }
        Ok(())
    }
}

impl Drop for WriteTransaction {
    fn drop(&mut self) {
        if self.conn.is_some() {
            // The connection is returned to the pool with an open transaction.
            // The pool's `before_acquire` hook issues a ROLLBACK before
            // handing it to the next consumer, so no async work is needed
            // here. If the pool is being shut down, SQLite itself rolls back
            // uncommitted transactions when the connection closes.
            log::warn!("WriteTransaction dropped without commit or rollback");
        }
    }
}

impl std::ops::Deref for WriteTransaction {
    type Target = SqliteConnection;
    fn deref(&self) -> &Self::Target {
        self.conn
            .as_ref()
            .expect("BUG: WriteTransaction dereferenced after being consumed")
            .deref()
    }
}

impl std::ops::DerefMut for WriteTransaction {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.conn
            .as_mut()
            .expect("BUG: WriteTransaction dereferenced after being consumed")
            .deref_mut()
    }
}

impl Database {
    pub async fn try_new(
        config: &DatabaseConfig,
        broadcasts: &Broadcasts,
        shutdown: tokio::sync::watch::Receiver<()>,
    ) -> Result<Self> {
        tokio::fs::create_dir_all(&config.databases_directory_path)
            .await
            .with_context(|| {
                format!(
                    "Failed to create databases directory at `{}`",
                    config.databases_directory_path.to_string_lossy()
                )
            })?;

        let mut connection_pools = std::collections::HashMap::new();

        info!("Applying pending database migrations");
        let mut entries = tokio::fs::read_dir(&config.databases_directory_path).await?;
        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_name().to_string_lossy().ends_with(".sqlite") {
                continue;
            }

            let vault: VaultId = entry
                .file_name()
                .to_string_lossy()
                .trim_end_matches(".sqlite")
                .to_owned();

            Self::validate_vault_id(&vault)?;

            let pool = Self::create_vault_database(config, &vault).await?;
            let cell = Arc::new(OnceCell::new());
            cell.set(pool).expect("cell is new");
            connection_pools.insert(
                vault.clone(),
                Arc::new(VaultPool {
                    cell,
                    last_accessed: Mutex::new(Instant::now()),
                }),
            );
        }
        info!("Database migrations applied");

        let database = Self {
            config: config.clone(),
            connection_pools: Arc::new(Mutex::new(connection_pools)),
            broadcasts: broadcasts.clone(),
        };

        database.start_idle_pool_cleanup(shutdown);

        Ok(database)
    }

    async fn create_vault_database(
        config: &DatabaseConfig,
        vault: &VaultId,
    ) -> Result<Pool<Sqlite>> {
        let file_name = config
            .databases_directory_path
            .join(format!("{vault}.sqlite"));

        // Database-level PRAGMAs (auto_vacuum, journal_mode) require a write
        // lock and persist across connections. Set them once with a dedicated
        // init connection so pool connections never need the write lock just to
        // open.
        let init_options = SqliteConnectOptions::new()
            .filename(file_name.clone())
            .create_if_missing(true)
            .auto_vacuum(sqlx::sqlite::SqliteAutoVacuum::Incremental)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

        // Run migrations on a dedicated connection, NOT through the pool.
        // The pool's `before_acquire` hook issues ROLLBACK on every checkout,
        // which can roll back the migration's bookkeeping transaction (the
        // _sqlx_migrations INSERT) while the DDL (ALTER TABLE) has already
        // auto-committed — leaving the migration in a dirty state.
        //
        // Uses `run_direct` instead of `run` because `run` takes
        // `impl Acquire<'_>`, whose lifetime bound prevents the enclosing
        // future from satisfying the `Send` requirement of axum handlers.
        let mut init_conn = sqlx::SqliteConnection::connect_with(&init_options).await?;
        sqlx::migrate!("src/app_state/database/migrations")
            .run_direct(&mut init_conn)
            .await
            .context("Cannot run pending migrations")?;
        drop(init_conn);

        // Pool connections only set per-connection PRAGMAs that don't require a
        // write lock. journal_mode = WAL is a no-op on an already-WAL database.
        let pool_options = SqliteConnectOptions::new()
            .filename(file_name.clone())
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(30))
            .log_slow_statements(log::LevelFilter::Warn, Duration::from_secs(30));

        let pool = SqlitePoolOptions::new()
            .max_connections(config.max_connections_per_vault)
            .acquire_slow_threshold(Duration::from_secs(30))
            .test_before_acquire(true)
            .before_acquire(|conn, _meta| {
                Box::pin(async move {
                    // Ensure the connection has no leftover open transaction
                    // (e.g. from a WriteTransaction that was dropped without
                    // commit/rollback). ROLLBACK is a harmless no-op if no
                    // transaction is active.
                    if let Err(e) = sqlx::query("ROLLBACK").execute(&mut *conn).await {
                        // "cannot rollback - no transaction is active" is the
                        // common case (connection returned cleanly). Only
                        // unexpected errors deserve attention.
                        log::debug!("before_acquire ROLLBACK failed: {e}");
                    }
                    Ok(true)
                })
            })
            .connect_with(pool_options)
            .await
            .with_context(|| format!("Cannot open database at `{}`", file_name.display()))?;

        Ok(pool)
    }


    fn validate_vault_id(vault: &VaultId) -> Result<()> {
        if vault.is_empty() {
            anyhow::bail!("Vault ID must not be empty");
        }
        if vault.contains('/')
            || vault.contains('\\')
            || vault.contains("..")
            || vault.contains('\0')
        {
            anyhow::bail!(
                "Invalid vault ID: must not contain path separators, '..', or null bytes"
            );
        }
        Ok(())
    }

    async fn get_connection_pool(&self, vault: &VaultId) -> Result<Pool<Sqlite>> {
        Self::validate_vault_id(vault)?;

        // Get or create the VaultPool entry. The global lock is held only
        // long enough for a HashMap lookup/insert — never across
        // create_vault_database.
        let vault_pool = {
            let mut pools = self.connection_pools.lock().await;
            pools
                .entry(vault.clone())
                .or_insert_with(|| {
                    Arc::new(VaultPool {
                        cell: Arc::new(OnceCell::new()),
                        last_accessed: Mutex::new(Instant::now()),
                    })
                })
                .clone()
        };

        // OnceCell::get_or_try_init guarantees exactly-once
        // initialization: concurrent callers for the same vault wait
        // here; callers for other vaults are not blocked.
        let config = self.config.clone();
        let vault_clone = vault.clone();
        let pool = vault_pool
            .cell
            .get_or_try_init(|| async {
                Self::create_vault_database(&config, &vault_clone).await
            })
            .await?;

        *vault_pool.last_accessed.lock().await = Instant::now();
        Ok(pool.clone())
    }

    pub async fn create_write_transaction(&self, vault: &VaultId) -> Result<WriteTransaction> {
        let pool = self.get_connection_pool(vault).await?;
        WriteTransaction::new(&pool).await
    }

    /// Return the latest state of all documents in the vault
    pub async fn get_latest_documents(
        &self,
        vault: &VaultId,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Vec<DocumentVersionWithoutContent>> {
        let query = sqlx::query!(
            r#"
            select
                vault_update_id,
                document_id as "document_id: Hyphenated",
                relative_path,
                updated_date as "updated_date: chrono::DateTime<Utc>",
                is_deleted,
                user_id,
                device_id,
                length(content) as "content_size: u64"
            from latest_document_versions
            order by vault_update_id
            "#,
        );

        if let Some(conn) = connection {
            query.fetch_all(&mut *conn).await
        } else {
            query
                .fetch_all(&self.get_connection_pool(vault).await?)
                .await
        }
        .context("Cannot fetch latest documents")
        .map(|rows| {
            rows.into_iter()
                .map(|row| DocumentVersionWithoutContent {
                    vault_update_id: row.vault_update_id,
                    document_id: row.document_id.into(),
                    relative_path: row.relative_path,
                    updated_date: row.updated_date,
                    is_deleted: row.is_deleted,
                    user_id: row.user_id,
                    device_id: row.device_id,
                    content_size: row.content_size.unwrap_or(0),
                })
                .collect()
        })
    }

    /// Return the latest state of all documents (including deleted) in the
    /// vault which have changed since the given update id
    pub async fn get_latest_documents_since(
        &self,
        vault: &VaultId,
        vault_update_id: VaultUpdateId,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Vec<DocumentVersionWithoutContent>> {
        let query = sqlx::query!(
            r#"
            select
                vault_update_id,
                document_id as "document_id: Hyphenated",
                relative_path,
                updated_date as "updated_date: chrono::DateTime<Utc>",
                is_deleted,
                user_id,
                device_id,
                length(content) as "content_size: u64"
            from latest_document_versions
            where vault_update_id > ?
            order by vault_update_id
            "#,
            vault_update_id
        );

        if let Some(conn) = connection {
            query.fetch_all(&mut *conn).await
        } else {
            query
                .fetch_all(&self.get_connection_pool(vault).await?)
                .await
        }
        .with_context(|| {
            format!("Cannot fetch latest documents since vault_update_id `{vault_update_id}`")
        })
        .map(|rows| {
            rows.into_iter()
                .map(|row| DocumentVersionWithoutContent {
                    vault_update_id: row.vault_update_id,
                    document_id: row.document_id.into(),
                    relative_path: row.relative_path,
                    updated_date: row.updated_date,
                    is_deleted: row.is_deleted,
                    user_id: row.user_id,
                    device_id: row.device_id,
                    content_size: row.content_size.unwrap_or(0),
                })
                .collect()
        })
    }

    pub async fn get_max_update_id_in_vault(
        &self,
        vault: &VaultId,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<i64> {
        let query = sqlx::query!(
            r#"
            select coalesce(max(vault_update_id), 0) as max_vault_update_id
            from documents
            "#,
        );

        if let Some(conn) = connection {
            query.fetch_one(&mut *conn).await
        } else {
            query
                .fetch_one(&self.get_connection_pool(vault).await?)
                .await
        }
        .map(|row| row.max_vault_update_id)
        .context("Cannot fetch max update id in vault")
    }

    pub async fn get_latest_non_deleted_document_by_path(
        &self,
        vault: &VaultId,
        relative_path: &str,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Option<StoredDocumentVersion>> {
        let query = sqlx::query_as!(
            StoredDocumentVersion,
            r#"
            select
                vault_update_id,
                document_id as "document_id: Hyphenated",
                relative_path,
                updated_date as "updated_date: chrono::DateTime<Utc>",
                content,
                is_deleted,
                user_id,
                device_id,
                has_been_merged,
                idempotency_key
            from latest_document_versions
            where relative_path = ? and is_deleted = false
            order by vault_update_id desc  -- `latest_document_versions` only contains a single latest version of each document, however,
                                            -- multiple documents can have the same `relative_path`, if they have been deleted. That's
                                            -- why we only care about the latest version of the document with the given relative path.
            limit 1
            "#,
            relative_path
        );

        if let Some(conn) = connection {
            query.fetch_optional(&mut *conn).await
        } else {
            query
                .fetch_optional(&self.get_connection_pool(vault).await?)
                .await
        }
        .context("Cannot fetch latest document version")
    }

    pub async fn get_latest_document(
        &self,
        vault: &VaultId,
        document_id: &DocumentId,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Option<StoredDocumentVersion>> {
        let document_id = document_id.as_hyphenated();
        let query = sqlx::query_as!(
            StoredDocumentVersion,
            r#"
            select
                vault_update_id,
                document_id as "document_id: Hyphenated",
                relative_path,
                updated_date as "updated_date: chrono::DateTime<Utc>",
                content,
                is_deleted,
                user_id,
                device_id,
                has_been_merged,
                idempotency_key
            from latest_document_versions
            where document_id = ?
            "#,
            document_id
        );

        if let Some(conn) = connection {
            query.fetch_optional(&mut *conn).await
        } else {
            query
                .fetch_optional(&self.get_connection_pool(vault).await?)
                .await
        }
        .context("Cannot fetch latest document version")
    }

    pub async fn get_document_version(
        &self,
        vault: &VaultId,
        vault_update_id: VaultUpdateId,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Option<StoredDocumentVersion>> {
        let query = sqlx::query_as!(
            StoredDocumentVersion,
            r#"
            select
                vault_update_id,
                document_id as "document_id: Hyphenated",
                relative_path,
                updated_date as "updated_date: chrono::DateTime<Utc>",
                content,
                is_deleted,
                user_id,
                device_id,
                has_been_merged,
                idempotency_key
            from documents
            where vault_update_id = ?"#,
            vault_update_id
        );

        if let Some(conn) = connection {
            query.fetch_optional(&mut *conn).await
        } else {
            query
                .fetch_optional(&self.get_connection_pool(vault).await?)
                .await
        }
        .context("Cannot fetch document version")
    }

    // inserting the document must be the last step of the transaction if there's one
    pub async fn insert_document_version(
        &self,
        vault_id: &VaultId,
        version: &StoredDocumentVersion,
        transaction: Option<WriteTransaction>,
    ) -> Result<()> {
        let document_id = version.document_id.as_hyphenated();
        let query = sqlx::query!(
            r#"
            insert into documents (
                vault_update_id,
                document_id,
                relative_path,
                updated_date,
                content,
                is_deleted,
                user_id,
                device_id,
                idempotency_key,
                has_been_merged
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            version.vault_update_id,
            document_id,
            version.relative_path,
            version.updated_date,
            version.content,
            version.is_deleted,
            version.user_id,
            version.device_id,
            version.idempotency_key,
            version.has_been_merged
        );

        if let Some(mut transaction) = transaction {
            query
                .execute(&mut *transaction)
                .await
                .context("Cannot insert document version")?;

            transaction
                .commit()
                .await
                .context("Failed to commit transaction")?;
        } else {
            query
                .execute(&self.get_connection_pool(vault_id).await?)
                .await
                .context("Cannot insert document version")?;
        }

        self.broadcasts
            .send_document_update(
                vault_id.clone(),
                WebSocketServerMessageWithOrigin::with_origin(
                    version.device_id.clone(),
                    WebSocketServerMessage::VaultUpdate(WebSocketVaultUpdate {
                        documents: vec![version.clone().into()],
                        is_initial_sync: false,
                    }),
                ),
            )
            .await;

        Ok(())
    }

    pub async fn get_document_by_idempotency_key(
        &self,
        vault: &VaultId,
        idempotency_key: &str,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Option<StoredDocumentVersion>> {
        // Start from the `documents` table (which has an index on
        // `idempotency_key`) to find the document_id, then join to
        // `latest_document_versions` for the latest state.
        let query = sqlx::query_as!(
            StoredDocumentVersion,
            r#"
            select
                ldv.vault_update_id,
                ldv.document_id as "document_id: Hyphenated",
                ldv.relative_path,
                ldv.updated_date as "updated_date: chrono::DateTime<Utc>",
                ldv.content,
                ldv.is_deleted,
                ldv.user_id,
                ldv.device_id,
                ldv.has_been_merged,
                ldv.idempotency_key
            from documents d
            inner join latest_document_versions ldv on d.document_id = ldv.document_id
            where d.idempotency_key = ?
            order by ldv.vault_update_id desc
            limit 1
            "#,
            idempotency_key
        );

        if let Some(conn) = connection {
            query.fetch_optional(&mut *conn).await
        } else {
            query
                .fetch_optional(&self.get_connection_pool(vault).await?)
                .await
        }
        .context("Cannot fetch document by idempotency key")
    }

    /// Return all versions (without content) of a specific document, ordered by `vault_update_id`
    pub async fn get_document_versions(
        &self,
        vault: &VaultId,
        document_id: &DocumentId,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Vec<DocumentVersionWithoutContent>> {
        let document_id = document_id.as_hyphenated();
        let query = sqlx::query!(
            r#"
            select
                vault_update_id,
                document_id as "document_id: Hyphenated",
                relative_path,
                updated_date as "updated_date: chrono::DateTime<Utc>",
                is_deleted,
                user_id,
                device_id,
                length(content) as "content_size: u64"
            from documents
            where document_id = ?
            order by vault_update_id
            "#,
            document_id,
        );

        if let Some(conn) = connection {
            query.fetch_all(&mut *conn).await
        } else {
            query
                .fetch_all(&self.get_connection_pool(vault).await?)
                .await
        }
        .with_context(|| format!("Cannot fetch document versions for document `{document_id}`"))
        .map(|rows| {
            rows.into_iter()
                .map(|row| DocumentVersionWithoutContent {
                    vault_update_id: row.vault_update_id,
                    document_id: row.document_id.into(),
                    relative_path: row.relative_path,
                    updated_date: row.updated_date,
                    is_deleted: row.is_deleted,
                    user_id: row.user_id,
                    device_id: row.device_id,
                    content_size: row.content_size.unwrap_or(0),
                })
                .collect()
        })
    }

    /// Return all versions across all documents, paginated, ordered by `vault_update_id` DESC
    pub async fn get_vault_history(
        &self,
        vault: &VaultId,
        limit: i64,
        before_update_id: Option<VaultUpdateId>,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Vec<DocumentVersionWithoutContent>> {
        let map_row = |row: VaultHistoryRow| DocumentVersionWithoutContent {
            vault_update_id: row.vault_update_id,
            document_id: row.document_id,
            relative_path: row.relative_path,
            updated_date: row.updated_date,
            is_deleted: row.is_deleted,
            user_id: row.user_id,
            device_id: row.device_id,
            content_size: row.content_size.unwrap_or(0),
        };

        if let Some(before) = before_update_id {
            let query = sqlx::query_as!(
                VaultHistoryRow,
                r#"
                select
                    vault_update_id,
                    document_id as "document_id: Hyphenated",
                    relative_path,
                    updated_date as "updated_date: chrono::DateTime<Utc>",
                    is_deleted,
                    user_id,
                    device_id,
                    length(content) as "content_size: u64"
                from documents
                where vault_update_id < ?
                order by vault_update_id desc
                limit ?
                "#,
                before,
                limit,
            );

            let rows = if let Some(conn) = connection {
                query.fetch_all(&mut *conn).await
            } else {
                query
                    .fetch_all(&self.get_connection_pool(vault).await?)
                    .await
            }
            .context("Cannot fetch vault history")?;

            Ok(rows.into_iter().map(map_row).collect())
        } else {
            let query = sqlx::query_as!(
                VaultHistoryRow,
                r#"
                select
                    vault_update_id,
                    document_id as "document_id: Hyphenated",
                    relative_path,
                    updated_date as "updated_date: chrono::DateTime<Utc>",
                    is_deleted,
                    user_id,
                    device_id,
                    length(content) as "content_size: u64"
                from documents
                order by vault_update_id desc
                limit ?
                "#,
                limit,
            );

            let rows = if let Some(conn) = connection {
                query.fetch_all(&mut *conn).await
            } else {
                query
                    .fetch_all(&self.get_connection_pool(vault).await?)
                    .await
            }
            .context("Cannot fetch vault history")?;

            Ok(rows.into_iter().map(map_row).collect())
        }
    }

    /// Cleanup idle connection pools that haven't been accessed in more than 5 minutes
    async fn cleanup_idle_pools(&self) {
        // Collect idle vaults and remove them from the map while holding
        // the lock briefly. Close pools OUTSIDE the lock so that
        // pool.close().await doesn't block other get_connection_pool calls.
        let idle_pools: Vec<(VaultId, Arc<VaultPool>)> = {
            let mut pools = self.connection_pools.lock().await;
            let now = Instant::now();

            let vaults_to_remove: Vec<VaultId> = pools
                .iter()
                .filter(|(_, vp)| {
                    // If the lock is contested, the pool is actively used — not idle.
                    let Ok(last) = vp.last_accessed.try_lock() else {
                        return false;
                    };
                    now.duration_since(*last) > IDLE_POOL_TIMEOUT
                })
                .map(|(vault_id, _)| vault_id.clone())
                .collect();

            vaults_to_remove
                .into_iter()
                .filter_map(|id| pools.remove(&id).map(|vp| (id, vp)))
                .collect()
        };

        for (vault_id, vault_pool) in idle_pools {
            if let Some(pool) = vault_pool.cell.get() {
                info!("Closing idle database connection pool for vault `{vault_id}`");
                pool.close().await;
            }
        }
    }

    /// Start a background task that periodically cleans up idle connection pools
    fn start_idle_pool_cleanup(&self, mut shutdown: tokio::sync::watch::Receiver<()>) {
        let database = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60)); // Check every minute
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        database.cleanup_idle_pools().await;
                    }
                    _ = shutdown.changed() => {
                        info!("Idle pool cleanup task shutting down");
                        break;
                    }
                }
            }
        });
    }
}
