use core::time::Duration;
use std::{collections::HashMap, sync::Arc, sync::atomic::{AtomicU64, Ordering}};

use anyhow::{Context as _, Result};
use log::info;
use models::{
    DocumentId, DocumentVersionWithoutContent, StoredDocumentVersion, VaultId, VaultUpdateId,
};
use sqlx::{ConnectOptions, Connection, sqlite::SqliteConnectOptions, types::chrono::Utc};

pub mod models;

/// Sentinel error indicating the SQLite database is busy (SQLITE_BUSY).
/// Handlers can downcast to this to return 429 instead of 500.
#[derive(Debug, thiserror::Error)]
#[error("Database is busy")]
pub struct WriteBusyError;

use sqlx::{
    Pool, Sqlite, pool::PoolConnection, sqlite::SqliteConnection, sqlite::SqlitePoolOptions,
};
use tokio::sync::{Mutex, OnceCell};
use tokio::time::Instant;
use uuid::fmt::Hyphenated;

use super::websocket::{
    broadcasts::Broadcasts,
    models::{WebSocketServerMessage, WebSocketServerMessageWithOrigin, WebSocketVaultUpdate},
};
use crate::config::database_config::DatabaseConfig;
use crate::consts::IDLE_POOL_TIMEOUT;

/// Holds separate reader and writer pools for a single vault.
/// The writer pool has exactly 1 connection so writes never compete
/// with reads for pool slots.
#[derive(Debug, Clone)]
struct VaultPools {
    reader: Pool<Sqlite>,
    writer: Pool<Sqlite>,
}

#[derive(Debug)]
struct VaultPool {
    cell: Arc<OnceCell<VaultPools>>,
    /// Monotonic timestamp in milliseconds (from `Instant::now()` at server start)
    last_accessed_ms: AtomicU64,
}

#[derive(Clone, Debug)]
pub struct Database {
    config: DatabaseConfig,
    broadcasts: Broadcasts,
    connection_pools: Arc<Mutex<HashMap<VaultId, Arc<VaultPool>>>>,
    /// Per-vault write serialization. SQLite allows only one writer at a
    /// time; `BEGIN IMMEDIATE` on a second connection blocks until the first
    /// commits (up to `busy_timeout`). Under concurrent load the blocked
    /// connections consume the pool, starving even read-only requests.
    /// This mutex moves the wait from the SQLite layer (where it holds a
    /// pool connection) to the Tokio layer (where it holds nothing).
    write_locks: Arc<Mutex<HashMap<VaultId, Arc<tokio::sync::Mutex<()>>>>>,
    /// Monotonic epoch for lock-free `last_accessed_ms` timestamps
    epoch: Instant,
}

/// A write transaction backed by a raw `BEGIN IMMEDIATE` instead of sqlx's
/// savepoint-based `Transaction`. This avoids the savepoint mismatch caused
/// by the old `END; BEGIN IMMEDIATE;` workaround.
///
/// Holds an `OwnedMutexGuard` that serializes write transactions per vault
/// at the application level (see `Database::write_locks`). The guard is
/// released when the transaction is committed, rolled back, or dropped.
pub struct WriteTransaction {
    conn: Option<PoolConnection<Sqlite>>,
    _write_guard: tokio::sync::OwnedMutexGuard<()>,
}

impl WriteTransaction {
    async fn new(pool: &Pool<Sqlite>, write_guard: tokio::sync::OwnedMutexGuard<()>) -> Result<Self> {
        let mut conn = pool
            .acquire()
            .await
            .context("Cannot acquire connection for write transaction")?;
        if let Err(e) = sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
        {
            let is_busy = match &e {
                sqlx::Error::Database(db_err) => {
                    // SQLITE_BUSY base code is 5. Extended codes share base 5.
                    let busy_by_code = db_err.code().is_some_and(|c| {
                        c.parse::<u32>().is_ok_and(|n| n & 0xFF == 5)
                    });
                    busy_by_code || db_err.message().contains("database is locked")
                }
                _ => false,
            };
            if is_busy {
                return Err(WriteBusyError.into());
            }
            return Err(e).context("Cannot begin immediate transaction");
        }
        Ok(Self { conn: Some(conn), _write_guard: write_guard })
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

/// Ensure the connection has no leftover open transaction (e.g. from a
/// `WriteTransaction` that was dropped without commit/rollback). ROLLBACK
/// is a harmless no-op if no transaction is active.
fn rollback_before_acquire(
    conn: &mut SqliteConnection,
    _meta: sqlx::pool::PoolConnectionMetadata,
) -> futures::future::BoxFuture<'_, Result<bool, sqlx::Error>> {
    Box::pin(async move {
        if let Err(e) = sqlx::query("ROLLBACK").execute(&mut *conn).await {
            // "cannot rollback - no transaction is active" is the common
            // case (connection returned cleanly). Only unexpected errors
            // deserve attention.
            log::debug!("before_acquire ROLLBACK failed: {e}");
        }
        Ok(true)
    })
}

impl Database {
    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    /// Lists all vault IDs that exist on disk (have a `.sqlite` file).
    pub async fn list_vaults(&self) -> Result<Vec<VaultId>> {
        let mut vaults = Vec::new();
        let mut entries = tokio::fs::read_dir(&self.config.databases_directory_path)
            .await
            .context("Failed to read databases directory")?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(vault) = name.strip_suffix(".sqlite") {
                vaults.push(vault.to_owned());
            }
        }
        vaults.sort();
        Ok(vaults)
    }

    pub async fn get_vault_stats(
        &self,
        vault: &VaultId,
    ) -> Result<models::VaultStats> {
        let pool = self.get_connection_pool(vault).await?;
        let row = sqlx::query!(
            r#"
            SELECT
                (SELECT MIN(updated_date) FROM documents)
                    AS "created_at: chrono::DateTime<Utc>",
                (SELECT COUNT(DISTINCT document_id) FROM latest_document_versions
                 WHERE is_deleted = false)
                    AS "document_count!: u32"
            "#,
        )
        .fetch_one(&pool)
        .await?;
        Ok(models::VaultStats {
            created_at: row.created_at,
            document_count: row.document_count,
        })
    }

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

            let pools = Self::create_vault_database(config, &vault).await?;
            let cell = Arc::new(OnceCell::new());
            cell.set(pools).expect("cell is new");
            connection_pools.insert(
                vault.clone(),
                Arc::new(VaultPool {
                    cell,
                    last_accessed_ms: AtomicU64::new(0),
                }),
            );
        }
        info!("Database migrations applied");

        let database = Self {
            config: config.clone(),
            connection_pools: Arc::new(Mutex::new(connection_pools)),
            broadcasts: broadcasts.clone(),
            write_locks: Arc::new(Mutex::new(HashMap::new())),
            epoch: Instant::now(),
        };

        database.start_idle_pool_cleanup(shutdown);

        Ok(database)
    }

    async fn create_vault_database(
        config: &DatabaseConfig,
        vault: &VaultId,
    ) -> Result<VaultPools> {
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

        // Per-connection PRAGMAs shared by both reader and writer pools.
        // journal_mode = WAL is a no-op on an already-WAL database.
        let base_options = SqliteConnectOptions::new()
            .filename(file_name.clone())
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(30))
            .log_slow_statements(log::LevelFilter::Warn, Duration::from_secs(30))
            // In WAL mode, NORMAL is safe: data survives OS crashes, only the
            // last transaction can be lost on power failure. The default FULL
            // forces an extra fsync() per commit, roughly halving write throughput.
            .pragma("synchronous", "NORMAL")
            // 16 MB page cache per connection (negative = KiB). Reduces disk
            // reads for the latest_document_versions GROUP BY view.
            .pragma("cache_size", "-16384")
            // Memory-mapped I/O avoids read() syscalls. SQLite falls back to
            // regular I/O for writes and beyond the mapped region. 256 MB is
            // conservative; the OS handles actual memory pressure.
            .pragma("mmap_size", "268435456")
            // Keep temp tables and sort spillovers in memory instead of temp files.
            .pragma("temp_store", "MEMORY")
            // Cap WAL file growth at 64 MB. Without this, the WAL can grow
            // unbounded during heavy write bursts (e.g. E2E tests with many
            // concurrent clients). SQLite truncates to this size on checkpoint.
            .pragma("journal_size_limit", "67108864");

        // Reader pool: multiple connections for concurrent reads.
        let reader = SqlitePoolOptions::new()
            .max_connections(config.max_connections_per_vault)
            .acquire_slow_threshold(Duration::from_secs(30))
            // Disabled: the health-check query is subject to busy_timeout
            // and blocks all connection checkouts when a write is active,
            // starving the pool for up to 30s even for simple reads.
            // The before_acquire ROLLBACK hook is sufficient for cleanup.
            .test_before_acquire(false)
            .before_acquire(rollback_before_acquire)
            .connect_with(base_options.clone())
            .await
            .with_context(|| format!("Cannot open reader pool at `{}`", file_name.display()))?;

        // Writer pool: exactly 1 connection, dedicated to writes.
        // Since the Tokio mutex already serializes writers per vault, this
        // single connection is never contended. Separating it from the
        // reader pool ensures writes never compete with reads for pool slots.
        let writer = SqlitePoolOptions::new()
            .max_connections(1)
            .acquire_slow_threshold(Duration::from_secs(30))
            .test_before_acquire(false)
            .before_acquire(rollback_before_acquire)
            .connect_with(base_options)
            .await
            .with_context(|| format!("Cannot open writer pool at `{}`", file_name.display()))?;

        Ok(VaultPools { reader, writer })
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

    async fn get_vault_pools(&self, vault: &VaultId) -> Result<VaultPools> {
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
                        last_accessed_ms: AtomicU64::new(self.now_ms()),
                    })
                })
                .clone()
        };

        // OnceCell::get_or_try_init guarantees exactly-once
        // initialization: concurrent callers for the same vault wait
        // here; callers for other vaults are not blocked.
        let config = self.config.clone();
        let vault_clone = vault.clone();
        let pools = vault_pool
            .cell
            .get_or_try_init(|| async {
                Self::create_vault_database(&config, &vault_clone).await
            })
            .await?;

        vault_pool.last_accessed_ms.store(self.now_ms(), Ordering::Relaxed);
        Ok(pools.clone())
    }

    /// Return the reader pool for read-only queries.
    async fn get_connection_pool(&self, vault: &VaultId) -> Result<Pool<Sqlite>> {
        Ok(self.get_vault_pools(vault).await?.reader)
    }

    pub async fn create_write_transaction(&self, vault: &VaultId) -> Result<WriteTransaction> {
        let write_lock = {
            let mut locks = self.write_locks.lock().await;
            locks
                .entry(vault.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let write_guard = write_lock.lock_owned().await;
        let pools = self.get_vault_pools(vault).await?;
        WriteTransaction::new(&pools.writer, write_guard).await
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
                has_been_merged
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
                has_been_merged
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
                has_been_merged
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
                has_been_merged
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            version.vault_update_id,
            document_id,
            version.relative_path,
            version.updated_date,
            version.content,
            version.is_deleted,
            version.user_id,
            version.device_id,
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
        let map_row = |row: models::VaultHistoryRow| DocumentVersionWithoutContent {
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
                models::VaultHistoryRow,
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
                models::VaultHistoryRow,
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
            let now_ms = self.now_ms();
            let idle_threshold_ms = IDLE_POOL_TIMEOUT.as_millis() as u64;

            let vaults_to_remove: Vec<VaultId> = pools
                .iter()
                .filter(|(_, vp)| {
                    let last = vp.last_accessed_ms.load(Ordering::Relaxed);
                    now_ms.saturating_sub(last) > idle_threshold_ms
                })
                .map(|(vault_id, _)| vault_id.clone())
                .collect();

            vaults_to_remove
                .into_iter()
                .filter_map(|id| pools.remove(&id).map(|vp| (id, vp)))
                .collect()
        };

        // Close pools concurrently so cleanup doesn't serialise across vaults
        let closures: Vec<_> = idle_pools
            .into_iter()
            .filter_map(|(vault_id, vault_pool)| {
                vault_pool.cell.get().cloned().map(|pools| (vault_id, pools))
            })
            .collect();

        let handles: Vec<_> = closures
            .into_iter()
            .map(|(vault_id, pools)| {
                tokio::spawn(async move {
                    // Checkpoint the WAL before closing to reclaim disk space.
                    // Run on the blocking pool so disk I/O doesn't starve the runtime
                    let writer_clone = pools.writer.clone();
                    let ckpt_result = tokio::task::spawn_blocking(move || {
                        futures::executor::block_on(
                            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                                .execute(&writer_clone),
                        )
                    })
                    .await;

                    match ckpt_result {
                        Ok(Err(e)) => {
                            log::warn!("WAL checkpoint failed for vault `{vault_id}`: {e}");
                        }
                        Err(e) => {
                            log::warn!("WAL checkpoint task panicked for vault `{vault_id}`: {e}");
                        }
                        _ => {}
                    }

                    info!("Closing idle database connection pools for vault `{vault_id}`");
                    pools.reader.close().await;
                    pools.writer.close().await;
                })
            })
            .collect();

        for handle in handles {
            let _ = handle.await;
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
