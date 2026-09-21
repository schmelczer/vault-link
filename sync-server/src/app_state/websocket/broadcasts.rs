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
    admission: Arc<std::sync::Mutex<HashMap<VaultId, std::sync::Weak<tokio::sync::Semaphore>>>>,
    senders: Arc<Mutex<HashMap<VaultId, broadcast::Sender<Notification>>>>,
}

impl Broadcasts {
    pub fn new(config: &ServerConfig) -> Self {
        Self {
            capacity: config.max_clients_per_vault,
            admission: Arc::default(),
            senders: Arc::default(),
        }
    }

    pub fn try_admit(&self, vault: &VaultId) -> Option<tokio::sync::OwnedSemaphorePermit> {
        let mut limits = self.admission.lock().unwrap();
        limits.retain(|_, limit| limit.strong_count() > 0);
        let limit = limits
            .get(vault)
            .and_then(std::sync::Weak::upgrade)
            .unwrap_or_else(|| {
                let limit = Arc::new(tokio::sync::Semaphore::new(self.capacity));
                limits.insert(vault.clone(), Arc::downgrade(&limit));
                limit
            });
        limit.try_acquire_owned().ok()
    }

    async fn sender(&self, vault: VaultId) -> broadcast::Sender<Notification> {
        self.senders
            .lock()
            .await
            .entry(vault)
            .or_insert_with(|| broadcast::channel(self.capacity.max(1)).0)
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
