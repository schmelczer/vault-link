use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use log::{debug, warn};
use tokio::sync::{Mutex, broadcast};

use super::models::WebSocketServerMessageWithOrigin;
use crate::{app_state::database::models::VaultId, config::server_config::ServerConfig};

#[derive(Debug, Clone)]
pub struct Broadcasts {
    broadcast_channel_capacity: usize,
    // `tx` uses a blocking std::sync::Mutex because the critical section is
    // a HashMap lookup plus a synchronous `broadcast::Sender::send`. Making
    // this non-async lets `send_document_update` run without an `.await`,
    // so an axum handler that is cancelled between `transaction.commit()`
    // and the broadcast can never drop the notification mid-flight.
    tx: Arc<StdMutex<HashMap<VaultId, broadcast::Sender<WebSocketServerMessageWithOrigin>>>>,
    send_locks: Arc<Mutex<HashMap<VaultId, Arc<tokio::sync::Mutex<()>>>>>,
}

type TxMap = HashMap<VaultId, broadcast::Sender<WebSocketServerMessageWithOrigin>>;

impl Broadcasts {
    pub fn new(server_config: &ServerConfig) -> Self {
        Self {
            broadcast_channel_capacity: server_config.broadcast_channel_capacity,
            tx: Arc::new(StdMutex::new(HashMap::new())),
            send_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Acquire a per-vault lock that serializes broadcasts in commit order.
    /// Must be acquired before the insert, held through commit and broadcast.
    pub async fn acquire_send_lock(&self, vault: &VaultId) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.send_locks.lock().await;
            locks
                .entry(vault.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    /// Remove senders for vaults with no active receivers
    fn prune_inactive_vaults(tx_map: &mut TxMap) {
        tx_map.retain(|_, sender| sender.receiver_count() > 0);
    }

    pub fn get_receiver(
        &self,
        vault: VaultId,
        max_clients: usize,
    ) -> Result<broadcast::Receiver<WebSocketServerMessageWithOrigin>, crate::errors::SyncServerError>
    {
        let mut tx_map = self
            .tx
            .lock()
            .expect("broadcasts.tx mutex poisoned — a previous holder panicked");
        Self::prune_inactive_vaults(&mut tx_map);

        let sender = tx_map
            .entry(vault)
            .or_insert_with(|| broadcast::channel(self.broadcast_channel_capacity).0);

        // Hold the lock across the count check *and* the subscribe so the
        // `max_clients` cap is atomic: two concurrent callers can't both
        // observe `receiver_count() < max_clients` and both subscribe.
        if sender.receiver_count() >= max_clients {
            return Err(crate::errors::client_error(anyhow::anyhow!(
                "Vault has reached the maximum number of clients ({max_clients})"
            )));
        }

        Ok(sender.subscribe())
    }

    /// Notify all clients (who are subscribed to the vault) about an update.
    /// Synchronous: safe to invoke from a handler between `commit()` and
    /// function return without worrying about task cancellation dropping
    /// the broadcast mid-flight. Failures are logged, never propagated.
    pub fn send_document_update(
        &self,
        vault: VaultId,
        document: WebSocketServerMessageWithOrigin,
    ) {
        let mut tx_map = self
            .tx
            .lock()
            .expect("broadcasts.tx mutex poisoned — a previous holder panicked");
        Self::prune_inactive_vaults(&mut tx_map);

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
