use core::time::Duration;
use std::{collections::HashMap, sync::Arc};

use tokio::sync::Mutex;
use uuid::Uuid;

use super::{
    database::models::{DeviceId, VaultId},
    websocket::{
        broadcasts::{Broadcasts, Notification},
        models::{ClientCursors, CursorPositionFromServer},
    },
};
use crate::{
    app_state::websocket::models::DocumentWithCursors, config::database_config::DatabaseConfig,
};

#[derive(Clone, Debug)]
pub struct Cursors {
    config: DatabaseConfig,
    broadcasts: Broadcasts,
    vault_to_cursors: Arc<Mutex<HashMap<VaultId, Vec<ClientCursorsWithTimeToLive>>>>,
    sessions: Arc<Mutex<HashMap<VaultId, HashMap<DeviceId, Uuid>>>>,
}

impl Cursors {
    pub fn new(config: &DatabaseConfig, broadcasts: &Broadcasts) -> Self {
        Self {
            config: config.clone(),
            broadcasts: broadcasts.clone(),
            vault_to_cursors: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::default(),
        }
    }

    pub async fn register_connection(&self, vault_id: &str, device_id: &str) -> Uuid {
        let mut sessions = self.sessions.lock().await;
        let session = Uuid::new_v4();
        sessions
            .entry(vault_id.to_owned())
            .or_default()
            .insert(device_id.to_owned(), session);
        self.remove_device_cursors(vault_id, device_id).await;
        session
    }

    pub async fn update_cursors(
        &self,
        vault_id: VaultId,
        user_name: String,
        device_id: &DeviceId,
        session: Uuid,
        document_to_cursors: Vec<DocumentWithCursors>,
    ) {
        // A reconnect can overlap an old connection's buffered messages and
        // cleanup. Only the most recently authenticated session owns presence.
        let sessions = self.sessions.lock().await;
        if sessions
            .get(&vault_id)
            .and_then(|devices| devices.get(device_id))
            != Some(&session)
        {
            return;
        }
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

        self.broadcast_cursors(&vault_id, all_device_cursors).await;
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

    pub fn start_background_task(self) {
        tokio::spawn(async move {
            loop {
                self.remove_expired_cursors().await;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }

    async fn remove_expired_cursors(&self) {
        let mut vault_to_cursors = self.vault_to_cursors.lock().await;

        for (vault_id, cursors) in vault_to_cursors.iter_mut() {
            let previous_len = cursors.len();
            cursors.retain(|cursor| !cursor.is_expired(self.config.cursor_timeout));
            if cursors.len() != previous_len {
                self.broadcast_cursors(vault_id, cursors).await;
            }
        }
        vault_to_cursors.retain(|_, cursors| !cursors.is_empty());
    }

    async fn broadcast_cursors(&self, vault_id: &str, cursors: &[ClientCursorsWithTimeToLive]) {
        self.broadcasts
            .send(
                vault_id.to_owned(),
                Notification::Cursors(CursorPositionFromServer {
                    clients: cursors.iter().map(|c| c.client_cursors.clone()).collect(),
                }),
            )
            .await;
    }

    pub async fn remove_cursors_of_device(&self, vault_id: &str, device_id: &str, session: Uuid) {
        let mut sessions = self.sessions.lock().await;
        let Some(devices) = sessions.get_mut(vault_id) else {
            return;
        };
        if devices.get(device_id) != Some(&session) {
            return;
        }
        devices.remove(device_id);
        if devices.is_empty() {
            sessions.remove(vault_id);
        }
        self.remove_device_cursors(vault_id, device_id).await;
    }

    async fn remove_device_cursors(&self, vault_id: &str, device_id: &str) {
        let mut vault_to_cursors = self.vault_to_cursors.lock().await;

        if let Some(cursors) = vault_to_cursors.get_mut(vault_id) {
            let previous_len = cursors.len();

            cursors.retain(|c| c.client_cursors.device_id != device_id);

            if cursors.len() != previous_len {
                self.broadcast_cursors(vault_id, cursors).await;
            }

            if cursors.is_empty() {
                vault_to_cursors.remove(vault_id);
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::server_config::ServerConfig;

    #[tokio::test]
    async fn disconnect_broadcasts_remaining_clients_and_the_final_empty_state() {
        let broadcasts = Broadcasts::new(&ServerConfig::default());
        let cursors = Cursors::new(&DatabaseConfig::default(), &broadcasts);
        let mut sessions = HashMap::new();
        for device in ["one", "two"] {
            let session = cursors.register_connection("vault", device).await;
            sessions.insert(device, session);
            cursors
                .update_cursors(
                    "vault".to_owned(),
                    "user".to_owned(),
                    &device.to_owned(),
                    session,
                    vec![],
                )
                .await;
        }
        let mut receiver = broadcasts.get_receiver("vault".to_owned()).await;
        let mut other = broadcasts.get_receiver("other".to_owned()).await;
        cursors
            .remove_cursors_of_device("vault", "one", sessions["one"])
            .await;
        let Notification::Cursors(update) = receiver.try_recv().unwrap() else {
            panic!("expected cursors")
        };
        assert_eq!(update.clients.len(), 1);
        assert_eq!(update.clients[0].device_id, "two");

        cursors
            .remove_cursors_of_device("vault", "two", sessions["two"])
            .await;
        let Notification::Cursors(update) = receiver.try_recv().unwrap() else {
            panic!("expected cursors")
        };
        assert!(update.clients.is_empty());
        assert!(other.try_recv().is_err());
        cursors
            .remove_cursors_of_device("vault", "two", sessions["two"])
            .await;
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn expiration_broadcasts_only_changed_vaults_including_empty_ones() {
        let broadcasts = Broadcasts::new(&ServerConfig::default());
        let config = DatabaseConfig::default();
        let cursors = Cursors::new(&config, &broadcasts);
        for (vault, device) in [("vault", "expired"), ("vault", "live"), ("other", "live")] {
            let session = cursors.register_connection(vault, device).await;
            cursors
                .update_cursors(
                    vault.to_owned(),
                    "user".to_owned(),
                    &device.to_owned(),
                    session,
                    vec![],
                )
                .await;
        }
        cursors
            .vault_to_cursors
            .lock()
            .await
            .get_mut("vault")
            .unwrap()[0]
            .last_updated = std::time::Instant::now()
            .checked_sub(config.cursor_timeout + Duration::from_secs(1))
            .unwrap();
        let mut receiver = broadcasts.get_receiver("vault".to_owned()).await;
        let mut other = broadcasts.get_receiver("other".to_owned()).await;
        cursors.remove_expired_cursors().await;
        let Notification::Cursors(update) = receiver.try_recv().unwrap() else {
            panic!("expected cursors")
        };
        assert_eq!(update.clients.len(), 1);
        assert_eq!(update.clients[0].device_id, "live");
        assert!(other.try_recv().is_err());

        cursors
            .vault_to_cursors
            .lock()
            .await
            .get_mut("vault")
            .unwrap()[0]
            .last_updated = std::time::Instant::now()
            .checked_sub(config.cursor_timeout + Duration::from_secs(1))
            .unwrap();
        cursors.remove_expired_cursors().await;
        let Notification::Cursors(update) = receiver.try_recv().unwrap() else {
            panic!("expected cursors")
        };
        assert!(update.clients.is_empty());
        assert!(cursors.get_cursors(&"vault".to_owned()).await.is_empty());
        cursors.remove_expired_cursors().await;
        assert!(receiver.try_recv().is_err());
        assert!(other.try_recv().is_err());
    }
    #[tokio::test]
    async fn replacement_session_fences_old_updates_and_disconnects() {
        let broadcasts = Broadcasts::new(&ServerConfig::default());
        let cursors = Cursors::new(&DatabaseConfig::default(), &broadcasts);
        let vault = "vault".to_owned();
        let device = "device".to_owned();
        let old = cursors.register_connection(&vault, &device).await;
        cursors
            .update_cursors(vault.clone(), "old".to_owned(), &device, old, vec![])
            .await;
        let new = cursors.register_connection(&vault, &device).await;
        cursors
            .update_cursors(vault.clone(), "new".to_owned(), &device, new, vec![])
            .await;
        let mut receiver = broadcasts.get_receiver(vault.clone()).await;
        cursors
            .update_cursors(
                vault.clone(),
                "late old update".to_owned(),
                &device,
                old,
                vec![],
            )
            .await;
        cursors.remove_cursors_of_device(&vault, &device, old).await;
        assert!(receiver.try_recv().is_err());
        assert_eq!(cursors.get_cursors(&vault).await[0].user_name, "new");
        cursors.remove_cursors_of_device(&vault, &device, new).await;
        let Notification::Cursors(update) = receiver.try_recv().unwrap() else {
            panic!("expected cursors")
        };
        assert!(update.clients.is_empty());
        assert!(cursors.get_cursors(&vault).await.is_empty());
        assert!(cursors.sessions.lock().await.is_empty());
    }
}
