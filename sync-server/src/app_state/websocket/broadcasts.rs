use std::{collections::HashMap, sync::Arc};

use log::{debug, warn};
use tokio::sync::{Mutex, broadcast};

use super::models::WebSocketServerMessageWithOrigin;
use crate::{app_state::database::models::VaultId, config::server_config::ServerConfig};

#[derive(Debug, Clone)]
pub struct Broadcasts {
    broadcast_channel_capacity: usize,
    tx: Arc<Mutex<HashMap<VaultId, broadcast::Sender<WebSocketServerMessageWithOrigin>>>>,
}

impl Broadcasts {
    pub fn new(server_config: &ServerConfig) -> Self {
        Self {
            broadcast_channel_capacity: server_config.broadcast_channel_capacity,
            tx: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn get_receiver(
        &self,
        vault: VaultId,
        max_clients: usize,
    ) -> Result<broadcast::Receiver<WebSocketServerMessageWithOrigin>, crate::errors::SyncServerError>
    {
        let mut tx_map = self.tx.lock().await;

        // Prune senders for vaults with no active receivers
        tx_map.retain(|_, sender| sender.receiver_count() > 0);

        let sender = tx_map
            .entry(vault)
            .or_insert_with(|| broadcast::channel(self.broadcast_channel_capacity).0);

        if sender.receiver_count() >= max_clients {
            return Err(crate::errors::client_error(anyhow::anyhow!(
                "Vault has reached the maximum number of clients ({max_clients})"
            )));
        }

        Ok(sender.subscribe())
    }

    /// Notify all clients (who are subscribed to the vault) about an update.
    /// We only log failures and don't propagate them.
    pub async fn send_document_update(
        &self,
        vault: VaultId,
        document: WebSocketServerMessageWithOrigin,
    ) {
        let mut tx_map = self.tx.lock().await;

        // Prune senders for vaults with no active receivers
        tx_map.retain(|_, sender| sender.receiver_count() > 0);

        let sender = tx_map
            .entry(vault.clone())
            .or_insert_with(|| broadcast::channel(self.broadcast_channel_capacity).0);

        if sender.receiver_count() == 0 {
            debug!("Skipping broadcast, no clients connected for vault `{vault}`");
            return;
        }

        if let Err(e) = sender.send(document) {
            warn!("Failed to broadcast to vault `{vault}`: {e}");
        }
    }
}
