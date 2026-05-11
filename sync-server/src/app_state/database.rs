use core::time::Duration;
use std::{
    collections::HashMap,
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
};

use anyhow::{Context as _, Result};
use log::info;
use models::{
    DocumentId, DocumentVersionWithoutContent, StoredDocumentVersion, VaultId, VaultUpdateId,
};
use sqlx::{ConnectOptions, Connection, sqlite::SqliteConnectOptions, types::chrono::Utc};

use crate::errors::{SyncServerError, database_error, server_error};

pub mod models;

/// Sentinel error indicating the `SQLite` database is busy (`SQLITE_BUSY`).
/// Handlers can downcast to this to return 429 instead of 500.
#[derive(Debug, thiserror::Error)]
#[error("Database is busy")]
pub struct WriteBusyError;

/// Detects whether a `sqlx::Error` indicates the database is currently
/// unavailable for a retryable reason: a `SQLITE_BUSY` from the engine, or
/// a `PoolTimedOut` from our short acquire timeout. Both should surface as
/// 429 so the client retries instead of treating it as a server fault.
pub fn is_sqlite_busy_error(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Database(db_err) => {
            // SQLITE_BUSY base code is 5. Extended codes share base 5.
            let busy_by_code = db_err
                .code()
                .is_some_and(|c| c.parse::<u32>().is_ok_and(|n| n & 0xFF == 5));
            busy_by_code || db_err.message().contains("database is locked")
        }
        sqlx::Error::PoolTimedOut => true,
        _ => false,
    }
}

use sqlx::{
    Pool, Sqlite, pool::PoolConnection, sqlite::SqliteConnection, sqlite::SqlitePoolOptions,
};
use tokio::sync::{Mutex, OnceCell};
use tokio::time::Instant;
use uuid::fmt::Hyphenated;

use super::websocket::{
    broadcasts::Broadcasts,
    models::{WebSocketServerMessage, WebSocketVaultUpdate},
};
use crate::config::database_config::DatabaseConfig;
use crate::consts::{IDLE_POOL_TIMEOUT, POOL_ACQUIRE_TIMEOUT};

fn duration_millis_u64(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

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
    /// Per-vault write serialization. `SQLite` allows only one writer at a
    /// time; `BEGIN IMMEDIATE` on a second connection blocks until the first
    /// commits (up to `busy_timeout`). Under concurrent load the blocked
    /// connections consume the pool, starving even read-only requests.
    /// This mutex moves the wait from the `SQLite` layer (where it holds a
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
    async fn new(
        pool: &Pool<Sqlite>,
        write_guard: tokio::sync::OwnedMutexGuard<()>,
    ) -> Result<Self> {
        let mut conn = match pool.acquire().await {
            Ok(conn) => conn,
            Err(e) if is_sqlite_busy_error(&e) => return Err(WriteBusyError.into()),
            Err(e) => {
                return Err(anyhow::Error::from(e)
                    .context("Cannot acquire connection for write transaction"));
            }
        };
        if let Err(e) = sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await {
            if is_sqlite_busy_error(&e) {
                return Err(WriteBusyError.into());
            }
            return Err(e).context("Cannot begin immediate transaction");
        }
        Ok(Self {
            conn: Some(conn),
            _write_guard: write_guard,
        })
    }

    pub async fn commit(mut self) -> Result<(), SyncServerError> {
        if let Some(mut conn) = self.conn.take() {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .context("Failed to commit transaction")
                .map_err(database_error)?;
        }
        Ok(())
    }

    pub async fn rollback(mut self) -> Result<(), SyncServerError> {
        if let Some(mut conn) = self.conn.take() {
            sqlx::query("ROLLBACK")
                .execute(&mut *conn)
                .await
                .context("Failed to rollback transaction")
                .map_err(database_error)?;
        }
        Ok(())
    }

    pub fn connection_mut(&mut self) -> Result<&mut SqliteConnection> {
        self.conn
            .as_deref_mut()
            .context("WriteTransaction already consumed")
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
        duration_millis_u64(self.epoch.elapsed())
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

    async fn create_vault_database(config: &DatabaseConfig, vault: &VaultId) -> Result<VaultPools> {
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
        // Database-level PRAGMAs (auto_vacuum, journal_mode) are deliberately
        // omitted here: they require a write lock to verify or set, so issuing
        // them on every new pool connection blocks behind any in-flight writer
        // and can fail with SQLITE_BUSY just to open a connection. The init
        // connection above set them once; the WAL mode persists in the database
        // header, so subsequent opens pick it up automatically.
        let base_options = SqliteConnectOptions::new()
            .filename(file_name.clone())
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
            .acquire_timeout(POOL_ACQUIRE_TIMEOUT)
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
            .acquire_timeout(POOL_ACQUIRE_TIMEOUT)
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
            .get_or_try_init(|| async { Self::create_vault_database(&config, &vault_clone).await })
            .await?;

        vault_pool
            .last_accessed_ms
            .store(self.now_ms(), Ordering::Relaxed);
        Ok(pools.clone())
    }

    /// Return the reader pool for read-only queries.
    async fn get_connection_pool(&self, vault: &VaultId) -> Result<Pool<Sqlite>> {
        Ok(self.get_vault_pools(vault).await?.reader)
    }

    pub async fn create_write_transaction(
        &self,
        vault: &VaultId,
    ) -> Result<WriteTransaction, SyncServerError> {
        let write_lock = {
            let mut locks = self.write_locks.lock().await;
            locks
                .entry(vault.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let write_guard = write_lock.lock_owned().await;
        let pools = self.get_vault_pools(vault).await.map_err(database_error)?;
        WriteTransaction::new(&pools.writer, write_guard)
            .await
            .map_err(database_error)
    }

    /// Return the latest state of all documents in the vault, optionally
    /// bounded above by `up_to_vault_update_id` so that the result is a
    /// stable snapshot at exactly that cursor (commits past the cursor
    /// will be delivered separately via the broadcast channel).
    pub async fn get_latest_documents(
        &self,
        vault: &VaultId,
        up_to_vault_update_id: Option<VaultUpdateId>,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Vec<DocumentVersionWithoutContent>, SyncServerError> {
        // `i64::MAX` makes the upper bound a no-op for callers that don't
        // care about an exact snapshot (they pass `None`).
        let upper = up_to_vault_update_id.unwrap_or(i64::MAX);
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
            where vault_update_id <= ?
            order by vault_update_id
            "#,
            upper,
        );

        if let Some(conn) = connection {
            query.fetch_all(&mut *conn).await
        } else {
            query
                .fetch_all(
                    &self
                        .get_connection_pool(vault)
                        .await
                        .map_err(database_error)?,
                )
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
        .map_err(database_error)
    }

    /// Return the latest state of all documents (including deleted) in the
    /// vault which have changed since the given update id, bounded above
    /// by `up_to_vault_update_id` so the catch-up result is a stable
    /// snapshot at exactly that cursor. Commits past the cursor will be
    /// delivered separately via the broadcast channel.
    pub async fn get_latest_documents_since(
        &self,
        vault: &VaultId,
        vault_update_id: VaultUpdateId,
        up_to_vault_update_id: Option<VaultUpdateId>,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Vec<DocumentVersionWithoutContent>, SyncServerError> {
        // `i64::MAX` makes the upper bound a no-op for callers that don't
        // care about an exact snapshot (they pass `None`).
        let upper = up_to_vault_update_id.unwrap_or(i64::MAX);
        // Compute "latest version as of `upper`" per document — NOT
        // global latest. The `latest_document_versions` view is keyed
        // on global max, so a write that commits between the catch-up's
        // cursor capture (under broadcast send-lock) and this query
        // (which runs after drop-lock) would expose a `vault_update_id
        // > cursor` row that the cursor filter then drops, removing
        // the doc from the catch-up entirely. Computing the snapshot
        // from the documents table directly with the upper bound
        // applied at the GROUP BY layer keeps the catch-up
        // self-contained at exactly the cursor.
        let query = sqlx::query!(
            r#"
            select
                d.vault_update_id,
                d.document_id as "document_id: Hyphenated",
                d.relative_path,
                d.updated_date as "updated_date: chrono::DateTime<Utc>",
                d.is_deleted,
                d.user_id,
                d.device_id,
                length(d.content) as "content_size: u64"
            from documents d
            inner join (
                select document_id, max(vault_update_id) as max_vid
                from documents
                where vault_update_id <= ?
                group by document_id
            ) latest_at_cursor
                on d.document_id = latest_at_cursor.document_id
                and d.vault_update_id = latest_at_cursor.max_vid
            where d.vault_update_id > ?
            order by d.vault_update_id
            "#,
            upper,
            vault_update_id,
        );

        if let Some(conn) = connection {
            query.fetch_all(&mut *conn).await
        } else {
            query
                .fetch_all(
                    &self
                        .get_connection_pool(vault)
                        .await
                        .map_err(database_error)?,
                )
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
        .map_err(database_error)
    }

    pub async fn get_max_update_id_in_vault(
        &self,
        vault: &VaultId,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<i64, SyncServerError> {
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
                .fetch_one(
                    &self
                        .get_connection_pool(vault)
                        .await
                        .map_err(database_error)?,
                )
                .await
        }
        .map(|row| row.max_vault_update_id)
        .context("Cannot fetch max update id in vault")
        .map_err(database_error)
    }

    pub async fn get_latest_non_deleted_document_by_path(
        &self,
        vault: &VaultId,
        relative_path: &str,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Option<StoredDocumentVersion>, SyncServerError> {
        let query = sqlx::query_as!(
            StoredDocumentVersion,
            r#"
            select
                vault_update_id,
                creation_vault_update_id,
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
                .fetch_optional(
                    &self
                        .get_connection_pool(vault)
                        .await
                        .map_err(database_error)?,
                )
                .await
        }
        .context("Cannot fetch latest document version")
        .map_err(database_error)
    }

    /// Find a doc whose CREATE was authored by this device with
    /// matching content, and whose creation the requesting client
    /// hasn't observed yet (`creation_vault_update_id > last_seen`).
    /// Used by `create_document` to recover from a "lost create"
    /// race: this device's create response was discarded mid-flight,
    /// so the retry comes in as a brand-new create — possibly at a
    /// renamed path. Binding the retry to the existing doc avoids
    /// duplicating the content under a deconflicted path.
    ///
    /// Matches against the doc's CREATION version (not the latest)
    /// because a same-path concurrent create from another agent may
    /// have merged into our doc since: the latest version's content
    /// is the merge result, not what we originally sent. Joining on
    /// `creation_vault_update_id` recovers the original bytes.
    ///
    /// The `device_id` + `creation > last_seen` combination scopes
    /// the dedup to "we genuinely lost track of our own create";
    /// another agent's same-content doc won't match because of
    /// `device_id`, and a doc this client already saw won't match
    /// because of the watermark check.
    pub async fn find_unseen_lost_create_by_device_and_content(
        &self,
        vault: &VaultId,
        device_id: &str,
        last_seen_vault_update_id: VaultUpdateId,
        content: &[u8],
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Option<StoredDocumentVersion>, SyncServerError> {
        let query = sqlx::query_as!(
            StoredDocumentVersion,
            r#"
            select
                lv.vault_update_id,
                lv.creation_vault_update_id,
                lv.document_id as "document_id: Hyphenated",
                lv.relative_path,
                lv.updated_date as "updated_date: chrono::DateTime<Utc>",
                lv.content,
                lv.is_deleted,
                lv.user_id,
                lv.device_id,
                lv.has_been_merged
            from latest_document_versions lv
            inner join documents creation
                on creation.document_id = lv.document_id
                and creation.vault_update_id = lv.creation_vault_update_id
            where creation.device_id = ?
                and creation.content = ?
                and lv.is_deleted = false
                and lv.creation_vault_update_id > ?
            order by lv.creation_vault_update_id desc
            limit 1
            "#,
            device_id,
            content,
            last_seen_vault_update_id,
        );

        if let Some(conn) = connection {
            query.fetch_optional(&mut *conn).await
        } else {
            query
                .fetch_optional(
                    &self
                        .get_connection_pool(vault)
                        .await
                        .map_err(database_error)?,
                )
                .await
        }
        .context("Cannot fetch lost-create candidate")
        .map_err(database_error)
    }

    pub async fn get_latest_document(
        &self,
        vault: &VaultId,
        document_id: &DocumentId,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Option<StoredDocumentVersion>, SyncServerError> {
        let document_id = document_id.as_hyphenated();
        let query = sqlx::query_as!(
            StoredDocumentVersion,
            r#"
            select
                vault_update_id,
                creation_vault_update_id,
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
                .fetch_optional(
                    &self
                        .get_connection_pool(vault)
                        .await
                        .map_err(database_error)?,
                )
                .await
        }
        .context("Cannot fetch latest document version")
        .map_err(database_error)
    }

    pub async fn get_document_version(
        &self,
        vault: &VaultId,
        vault_update_id: VaultUpdateId,
        connection: Option<&mut SqliteConnection>,
    ) -> Result<Option<StoredDocumentVersion>, SyncServerError> {
        let query = sqlx::query_as!(
            StoredDocumentVersion,
            r#"
            select
                vault_update_id,
                creation_vault_update_id,
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
                .fetch_optional(
                    &self
                        .get_connection_pool(vault)
                        .await
                        .map_err(database_error)?,
                )
                .await
        }
        .context("Cannot fetch document version")
        .map_err(database_error)
    }

    // inserting the document must be the last step of the transaction
    pub async fn insert_document_version(
        &self,
        vault_id: &VaultId,
        version: &StoredDocumentVersion,
        mut transaction: WriteTransaction,
    ) -> Result<(), SyncServerError> {
        let document_id = version.document_id.as_hyphenated();
        let query = sqlx::query!(
            r#"
            insert into documents (
                vault_update_id,
                creation_vault_update_id,
                document_id,
                relative_path,
                updated_date,
                content,
                is_deleted,
                user_id,
                device_id,
                has_been_merged
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            version.vault_update_id,
            version.creation_vault_update_id,
            document_id,
            version.relative_path,
            version.updated_date,
            version.content,
            version.is_deleted,
            version.user_id,
            version.device_id,
            version.has_been_merged
        );

        // Acquire the broadcast send lock before the insert so that
        // broadcasts are serialized in vault_update_id order even after
        // the write transaction (and its per-vault lock) is released.
        let _send_guard = self.broadcasts.acquire_send_lock(vault_id).await;

        query
            .execute(transaction.connection_mut().map_err(server_error)?)
            .await
            .context("Cannot insert document version")
            .map_err(database_error)?;

        transaction.commit().await?;

        // Broadcast every commit to every connected client, including
        // the originator. The HTTP response is the originator's normal
        // path to learn its own update, but if the response is lost
        // (sync reset, dropped TCP) the broadcast is the only remaining
        // delivery channel — and the client-side `parentVersionId`
        // dedup absorbs the redundant message when the response made it
        // through.
        self.broadcasts.send_document_update(
            vault_id,
            WebSocketServerMessage::VaultUpdate(WebSocketVaultUpdate {
                document: version.clone().into(),
            }),
        )?;

        Ok(())
    }

    /// Cleanup idle connection pools that haven't been accessed in more than 5 minutes
    async fn cleanup_idle_pools(&self) {
        // Collect idle vaults and remove them from the map while holding
        // the lock briefly. Close pools OUTSIDE the lock so that
        // pool.close().await doesn't block other get_connection_pool calls.
        let idle_pools: Vec<(VaultId, Arc<VaultPool>)> = {
            let mut pools = self.connection_pools.lock().await;
            let now_ms = self.now_ms();
            let idle_threshold_ms = duration_millis_u64(IDLE_POOL_TIMEOUT);

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
                vault_pool
                    .cell
                    .get()
                    .cloned()
                    .map(|pools| (vault_id, pools))
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
                            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&writer_clone),
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
