use super::models::CursorPositionFromServer;
use crate::{app_state::database::models::VaultId, config::server_config::ServerConfig};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, broadcast};

#[derive(Debug, Clone)]
pub enum Notification {
    VaultUpdate,
    Cursors(CursorPositionFromServer),
}

#[derive(Debug, Clone)]
pub struct Broadcasts {
    capacity: usize,
    senders: Arc<Mutex<HashMap<VaultId, broadcast::Sender<Notification>>>>,
}

impl Broadcasts {
    pub fn new(config: &ServerConfig) -> Self {
        Self {
            capacity: config.max_clients_per_vault.max(1),
            senders: Arc::default(),
        }
    }

    async fn sender(&self, vault: VaultId) -> broadcast::Sender<Notification> {
        self.senders
            .lock()
            .await
            .entry(vault)
            .or_insert_with(|| broadcast::channel(self.capacity).0)
            .clone()
    }

    pub async fn get_receiver(&self, vault: VaultId) -> broadcast::Receiver<Notification> {
        self.sender(vault).await.subscribe()
    }

    pub async fn send(&self, vault: VaultId, notification: Notification) {
        // No listeners (or lagging listeners) is normal; they replay the log.
        let _ = self.sender(vault).await.send(notification);
    }

    pub async fn notify_about_vault_update(&self, vault: VaultId) {
        self.send(vault, Notification::VaultUpdate).await;
    }
}
