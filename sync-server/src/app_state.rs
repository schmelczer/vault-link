pub mod cursors;
pub mod database;
pub mod websocket;

use std::sync::{
    Arc,
    atomic::AtomicUsize,
};

use anyhow::Result;
use cursors::Cursors;
use database::Database;
use websocket::broadcasts::Broadcasts;

use crate::config::Config;

#[derive(Clone, Debug)]
pub struct AppState {
    pub config: Config,
    pub database: Database,
    pub cursors: Cursors,
    pub broadcasts: Broadcasts,
    /// Tracks WebSocket connections that have upgraded but not yet completed
    /// the authentication handshake.
    pub pending_ws_connections: Arc<AtomicUsize>,
    /// Send on this channel to stop background tasks (cursor cleanup,
    /// idle-pool cleanup). Held by `AppState` so dropping it also
    /// triggers shutdown.
    #[allow(dead_code)]
    shutdown_tx: Arc<tokio::sync::watch::Sender<()>>,
}

impl AppState {
    pub async fn try_new(config: Config) -> Result<Self> {
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(());

        let broadcasts = Broadcasts::new(&config.server);
        let database =
            Database::try_new(&config.database, &broadcasts, shutdown_rx.clone()).await?;
        let cursors: Cursors = Cursors::new(&config.database, &broadcasts);

        Cursors::start_background_task(cursors.clone(), shutdown_rx);

        Ok(Self {
            config,
            database,
            cursors,
            broadcasts,
            pending_ws_connections: Arc::new(AtomicUsize::new(0)),
            shutdown_tx: Arc::new(shutdown_tx),
        })
    }
}
