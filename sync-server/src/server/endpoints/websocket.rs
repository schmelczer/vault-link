use crate::{
    app_state::{
        AppState,
        database::models::{DeviceId, VaultId},
        websocket::{
            broadcasts::Notification,
            models::{CursorPositionFromServer, WebSocketClientMessage, WebSocketServerMessage},
            utils::{get_authenticated_handshake, send_update_over_websocket},
        },
    },
    consts::WEBSOCKET_HANDSHAKE_TIMEOUT,
    errors::{SyncServerError, client_error},
};
use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures::{
    StreamExt,
    stream::{SplitSink, SplitStream},
};
use log::{debug, info};
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;

use super::VaultPath;

#[axum::debug_handler]
pub async fn websocket_handler(
    ws: WebSocketUpgrade,
    Path(VaultPath(vault_id)): Path<VaultPath>,
    State(state): State<AppState>,
) -> Result<Response, SyncServerError> {
    debug!("Upgrading WebSocket connection for vault `{vault_id}`");

    let Some(permit) = state.broadcasts.try_admit(&vault_id).await else {
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            "Vault connection limit reached",
        )
            .into_response());
    };

    Ok(ws.on_upgrade(move |socket| async move {
        let _permit = permit;
        if let Err(error) = serve_connection(state, socket, vault_id).await {
            debug!("WebSocket disconnected: {error}");
        }
    }))
}

async fn serve_connection(
    state: AppState,
    socket: WebSocket,
    vault: VaultId,
) -> Result<(), SyncServerError> {
    let (mut sender, mut receiver) = socket.split();
    let authenticated = get_authenticated_handshake(
        &state,
        &vault,
        tokio::time::timeout(WEBSOCKET_HANDSHAKE_TIMEOUT, receiver.next())
            .await
            .map_err(|_| client_error(anyhow::anyhow!("WebSocket handshake deadline expired")))?
            .transpose()
            .unwrap_or_default(),
    )?;

    let device = authenticated.handshake.device_id;
    let session = state.cursors.register_connection(&vault, &device).await;
    info!("WebSocket connected to vault {vault}");

    let connection = AuthenticatedConnection {
        state: &state,
        vault: &vault,
        device: &device,
        user_name: &authenticated.user.name,
        session,
    };
    let result = connection.forward_updates(&mut sender, &mut receiver).await;

    state
        .cursors
        .remove_cursors_of_device(&vault, &device, session)
        .await;

    result
}

/// A session owns cursor presence until it disconnects or a newer session replaces it.
struct AuthenticatedConnection<'a> {
    state: &'a AppState,
    vault: &'a VaultId,
    device: &'a DeviceId,
    user_name: &'a str,
    session: uuid::Uuid,
}

impl AuthenticatedConnection<'_> {
    async fn forward_updates(
        &self,
        sender: &mut SplitSink<WebSocket, Message>,
        receiver: &mut SplitStream<WebSocket>,
    ) -> Result<(), SyncServerError> {
        let mut last_checkpoint = None;
        let mut notifications = self.state.broadcasts.get_receiver(self.vault.clone()).await;
        let mut timer = tokio::time::interval(Duration::from_secs(2));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            let checkpoint = self
                .state
                .database
                .get_history_checkpoint(self.vault)
                .await?;
            if last_checkpoint.as_ref() != Some(&checkpoint) {
                send_update_over_websocket(&WebSocketServerMessage::VaultChanged, sender).await?;
                last_checkpoint = Some(checkpoint);
            }

            tokio::select! {
                _ = timer.tick() => {},
                notification = notifications.recv() => {
                    match notification {
                        Ok(Notification::Cursors(positions)) => {
                            self.send_other_clients_cursors(positions, sender).await?;
                        }
                        // Recheck the durable head after either a notification or lag.
                        Ok(Notification::VaultUpdate) | Err(RecvError::Lagged(_)) => {},
                        Err(RecvError::Closed) => break,
                    }
                }
                incoming = receiver.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            self.handle_client_message(&text, sender).await?;
                        }
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                        _ => break,
                    }
                }
            }
        }

        Ok(())
    }

    async fn send_other_clients_cursors(
        &self,
        mut positions: CursorPositionFromServer,
        sender: &mut SplitSink<WebSocket, Message>,
    ) -> Result<(), SyncServerError> {
        positions
            .clients
            .retain(|client| client.device_id != *self.device);
        send_update_over_websocket(&WebSocketServerMessage::CursorPositions(positions), sender)
            .await
    }

    async fn handle_client_message(
        &self,
        text: &str,
        sender: &mut SplitSink<WebSocket, Message>,
    ) -> Result<(), SyncServerError> {
        let message: WebSocketClientMessage =
            serde_json::from_str(text).map_err(|error| client_error(error.into()))?;
        let WebSocketClientMessage::CursorPositions(positions) = message else {
            return Err(client_error(anyhow::anyhow!("Unexpected handshake")));
        };

        self.state
            .cursors
            .update_cursors(
                self.vault.clone(),
                self.user_name.to_owned(),
                self.device,
                self.session,
                positions.documents_with_cursors,
            )
            .await;

        let clients = self.state.cursors.get_cursors(self.vault).await;
        self.send_other_clients_cursors(CursorPositionFromServer { clients }, sender)
            .await
    }
}
