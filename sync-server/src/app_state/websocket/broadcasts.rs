use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use log::{debug, info, warn};
use tokio::sync::{Mutex, broadcast};

use super::models::{WebSocketServerMessage, WebSocketServerMessageWithOrigin};
use crate::{
    app_state::database::models::VaultId,
    config::server_config::ServerConfig,
    errors::{SyncServerError, client_error, server_error},
};

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
    fn prune_inactive_vaults(tx_map: &mut TxMap) -> Vec<VaultId> {
        let mut pruned = Vec::new();
        tx_map.retain(|vault, sender| {
            let alive = sender.receiver_count() > 0;
            if !alive {
                pruned.push(vault.clone());
            }
            alive
        });
        pruned
    }

    pub fn get_receiver(
        &self,
        vault: &VaultId,
        max_clients: usize,
    ) -> Result<broadcast::Receiver<WebSocketServerMessageWithOrigin>, SyncServerError> {
        let mut tx_map = self
            .tx
            .lock()
            .map_err(|_| server_error(anyhow::anyhow!("broadcasts.tx mutex poisoned")))?;

        let count_before_prune = tx_map
            .get(vault)
            .map_or(0, tokio::sync::broadcast::Sender::receiver_count);
        let pruned = Self::prune_inactive_vaults(&mut tx_map);
        let pruned_self = pruned
            .iter()
            .any(|pruned_vault| pruned_vault.as_str() == vault);

        let sender = tx_map
            .entry(vault.to_owned())
            .or_insert_with(|| broadcast::channel(self.broadcast_channel_capacity).0);

        // Hold the lock across the count check *and* the subscribe so the
        // `max_clients` cap is atomic: two concurrent callers can't both
        // observe `receiver_count() < max_clients` and both subscribe.
        if sender.receiver_count() >= max_clients {
            return Err(client_error(anyhow::anyhow!(
                "Vault has reached the maximum number of clients ({max_clients})"
            )));
        }

        let receiver = sender.subscribe();
        let count_after = sender.receiver_count();
        info!(
            "[BCAST] get_receiver vault={vault} count_before_prune={count_before_prune} pruned_self={pruned_self} pruned_total={} count_after_subscribe={count_after}",
            pruned.len()
        );
        Ok(receiver)
    }

    /// Notify all clients (who are subscribed to the vault) about an update.
    /// Synchronous: safe to invoke from a handler between `commit()` and
    /// function return without worrying about task cancellation dropping
    /// the broadcast mid-flight. Mutex poison is returned; send failures
    /// are logged because they can happen when receivers disconnect.
    pub fn send_document_update(
        &self,
        vault: &str,
        document: WebSocketServerMessageWithOrigin,
    ) -> Result<(), SyncServerError> {
        let vault_update_id = match &document.message {
            WebSocketServerMessage::VaultUpdate(u) => Some(u.document.vault_update_id),
            WebSocketServerMessage::CursorPositions(_) => None,
        };
        let is_deleted = match &document.message {
            WebSocketServerMessage::VaultUpdate(u) => Some(u.document.is_deleted),
            WebSocketServerMessage::CursorPositions(_) => None,
        };
        let mut tx_map = self.tx.lock().map_err(|_| {
            server_error(anyhow::anyhow!(
                "broadcasts.tx mutex poisoned; skipping document update broadcast"
            ))
        })?;
        let count_before_prune = tx_map
            .get(vault)
            .map_or(0, tokio::sync::broadcast::Sender::receiver_count);
        let pruned = Self::prune_inactive_vaults(&mut tx_map);
        let pruned_self = pruned
            .iter()
            .any(|pruned_vault| pruned_vault.as_str() == vault);

        let sender = tx_map
            .entry(vault.to_owned())
            .or_insert_with(|| broadcast::channel(self.broadcast_channel_capacity).0);

        let count_before_send = sender.receiver_count();

        if count_before_send == 0 {
            info!(
                "[BCAST] send_document_update vault={vault} vuid={vault_update_id:?} is_deleted={is_deleted:?} count_before_prune={count_before_prune} pruned_self={pruned_self} count_before_send=0 SKIPPED"
            );
            debug!("Skipping broadcast, no clients connected for vault `{vault}`");
            return Ok(());
        }

        let send_result = sender.send(document);
        match &send_result {
            Ok(n) => info!(
                "[BCAST] send_document_update vault={vault} vuid={vault_update_id:?} is_deleted={is_deleted:?} count_before_prune={count_before_prune} pruned_self={pruned_self} count_before_send={count_before_send} SENT delivered_to={n}"
            ),
            Err(e) => warn!(
                "[BCAST] send_document_update vault={vault} vuid={vault_update_id:?} is_deleted={is_deleted:?} count_before_prune={count_before_prune} pruned_self={pruned_self} count_before_send={count_before_send} FAILED err={e}"
            ),
        }
        Ok(())
    }
}
