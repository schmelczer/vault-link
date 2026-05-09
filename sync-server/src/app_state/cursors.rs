use core::time::Duration;
use std::{collections::HashMap, sync::Arc};

use tokio::sync::Mutex;

use super::{
    database::models::{DeviceId, VaultId},
    websocket::{
        broadcasts::Broadcasts,
        models::{
            ClientCursors, CursorPositionFromServer, WebSocketServerMessage,
            WebSocketServerMessageWithOrigin,
        },
    },
};
use crate::{
    app_state::websocket::models::DocumentWithCursors, config::database_config::DatabaseConfig,
    errors::SyncServerError,
};

const CURSOR_CLEANUP_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Debug)]
pub struct Cursors {
    config: DatabaseConfig,
    broadcasts: Broadcasts,
    vault_to_cursors: Arc<Mutex<HashMap<VaultId, Vec<ClientCursorsWithTimeToLive>>>>,
}

impl Cursors {
    pub fn new(config: &DatabaseConfig, broadcasts: &Broadcasts) -> Self {
        Self {
            config: config.clone(),
            broadcasts: broadcasts.clone(),
            vault_to_cursors: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn update_cursors(
        &self,
        vault_id: VaultId,
        user_name: String,
        device_id: &DeviceId,
        document_to_cursors: Vec<DocumentWithCursors>,
    ) -> Result<(), SyncServerError> {
        let mut vault_to_cursors = self.vault_to_cursors.lock().await;

        let all_device_cursors = vault_to_cursors
            .entry(vault_id.clone())
            .or_insert_with(Vec::new);

        all_device_cursors.retain(|c| &c.client_cursors.device_id != device_id);
        all_device_cursors.push(ClientCursorsWithTimeToLive::new(ClientCursors {
            user_name,
            device_id: device_id.clone(),
            documents_with_cursors: document_to_cursors,
        }));

        drop(vault_to_cursors); // Explicitly drop the lock before broadcasting to avoid deadlock
        self.broadcast_cursors_for_vault(&vault_id).await
    }

    pub async fn get_cursors(&self, vault_id: &VaultId) -> Vec<ClientCursors> {
        let vault_to_cursors = self.vault_to_cursors.lock().await;
        vault_to_cursors
            .get(vault_id)
            .map(|cursors| {
                cursors
                    .iter()
                    .cloned()
                    .map(|with_ttl| with_ttl.client_cursors)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    }

    pub fn start_background_task(self, mut shutdown: tokio::sync::watch::Receiver<()>) {
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = tokio::time::sleep(CURSOR_CLEANUP_INTERVAL) => {
                        self.remove_expired_cursors().await?;
                    }
                    Ok(()) = shutdown.changed() => break,
                }
            }

            Ok::<(), SyncServerError>(())
        });
    }

    async fn remove_expired_cursors(&self) -> Result<(), SyncServerError> {
        let changed_vaults: Vec<VaultId> = {
            let mut vault_to_cursors = self.vault_to_cursors.lock().await;

            let mut changed = Vec::new();
            for (vault_id, cursors) in vault_to_cursors.iter_mut() {
                let before = cursors.len();
                cursors.retain(|cursor| !cursor.is_expired(self.config.cursor_timeout));
                if cursors.len() != before {
                    changed.push(vault_id.clone());
                }
            }

            // Remove empty vault entries to prevent unbounded growth
            vault_to_cursors.retain(|_, cursors| !cursors.is_empty());

            changed
        };

        for vault_id in &changed_vaults {
            self.broadcast_cursors_for_vault(vault_id).await?;
        }

        Ok(())
    }

    async fn broadcast_cursors_for_vault(&self, vault_id: &VaultId) -> Result<(), SyncServerError> {
        let client_cursors: Vec<ClientCursors> = {
            let vault_to_cursors = self.vault_to_cursors.lock().await;
            vault_to_cursors
                .get(vault_id)
                .map(|cursors| cursors.iter().map(|c| c.client_cursors.clone()).collect())
                .unwrap_or_default()
        };

        self.broadcasts.send_document_update(
            vault_id,
            WebSocketServerMessageWithOrigin::new(WebSocketServerMessage::CursorPositions(
                CursorPositionFromServer {
                    clients: client_cursors,
                },
            )),
        )
    }

    pub async fn remove_cursors_of_device(
        &self,
        vault_id: &VaultId,
        device_id: &DeviceId,
    ) -> Result<(), SyncServerError> {
        let changed = {
            let mut vault_to_cursors = self.vault_to_cursors.lock().await;

            if let Some(cursors) = vault_to_cursors.get_mut(vault_id) {
                let before = cursors.len();
                cursors.retain(|c| c.client_cursors.device_id != *device_id);
                let changed = cursors.len() != before;
                if cursors.is_empty() {
                    vault_to_cursors.remove(vault_id);
                }
                changed
            } else {
                false
            }
        };

        if changed {
            self.broadcast_cursors_for_vault(vault_id).await?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct ClientCursorsWithTimeToLive {
    client_cursors: ClientCursors,
    last_updated: std::time::Instant,
}

impl ClientCursorsWithTimeToLive {
    fn new(client_cursors: ClientCursors) -> Self {
        Self {
            client_cursors,
            last_updated: std::time::Instant::now(),
        }
    }

    pub fn is_expired(&self, ttl: Duration) -> bool {
        self.last_updated.elapsed() > ttl
    }
}
