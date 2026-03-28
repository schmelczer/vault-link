pub mod cursors;
pub mod database;
pub mod websocket;

use std::sync::{Arc, atomic::AtomicUsize};

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
    /// the authentication handshake
    pub pending_ws_connections: Arc<AtomicUsize>,
    /// Send on this channel to stop background tasks (cursor cleanup,
    /// idle-pool cleanup)
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

    /// Signal all background tasks (idle pool cleanup, cursor cleanup) to stop
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(());
    }

    /// Get a receiver to be notified when shutdown is triggered
    pub fn subscribe_shutdown(&self) -> tokio::sync::watch::Receiver<()> {
        self.shutdown_tx.subscribe()
    }
}
