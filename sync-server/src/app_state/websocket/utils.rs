use anyhow::Context;
use axum::extract::ws::{Message, WebSocket};
use futures::{sink::SinkExt, stream::SplitSink};

use super::models::{WebSocketClientMessage, WebSocketHandshake, WebSocketServerMessage};
use crate::{
    app_state::{
        AppState,
        database::models::{DocumentVersionWithoutContent, VaultId, VaultUpdateId},
    },
    config::user_config::User,
    errors::{SyncServerError, client_error, server_error, unauthenticated_error},
    server::auth::authenticate_for_vault,
};

pub struct AuthenticatedWebSocketHandshake {
    pub handshake: WebSocketHandshake,
    pub user: User,
}

pub fn get_authenticated_handshake(
    state: &AppState,
    vault_id: &VaultId,
    message: Option<Message>,
) -> Result<AuthenticatedWebSocketHandshake, SyncServerError> {
    if let Some(Message::Text(message)) = message {
        let message: WebSocketClientMessage = serde_json::from_str(&message)
            .context("Failed to parse message")
            .map_err(client_error)?;

        match message {
            WebSocketClientMessage::Handshake(handshake) => {
                let user = authenticate_for_vault(state, handshake.token.trim(), vault_id)?;
                Ok(AuthenticatedWebSocketHandshake { handshake, user })
            }
            WebSocketClientMessage::CursorPositions(_) => Err(unauthenticated_error(
                anyhow::anyhow!("Expected a handshake message"),
            )),
        }
    } else {
        Err(unauthenticated_error(anyhow::anyhow!(
            "Failed to authenticate due to invalid message"
        )))
    }
}

/// Stream the documents the client missed while offline, bounded above
/// by `up_to_vault_update_id` so the catch-up is a stable snapshot at
/// exactly that cursor. The WebSocket handshake atomically subscribes
/// to the broadcast channel and snapshots this cursor under the per-
/// vault send lock; commits past the cursor are then delivered solely
/// through the broadcast channel (filtered by the same cursor on the
/// receive side), so every committed update is delivered exactly once.
/// We could've used a read transaction but that would've meant all other
/// clients would need to wait for the new client to catch up before
/// sending any updates.
pub async fn get_unseen_documents(
    state: &AppState,
    vault_id: &VaultId,
    last_seen_vault_update_id: Option<VaultUpdateId>,
    up_to_vault_update_id: VaultUpdateId,
) -> Result<Vec<DocumentVersionWithoutContent>, SyncServerError> {
    if let Some(update_id) = last_seen_vault_update_id {
        state
            .database
            .get_latest_documents_since(vault_id, update_id, Some(up_to_vault_update_id), None)
            .await
            .map_err(server_error)
    } else {
        state
            .database
            .get_latest_documents(vault_id, Some(up_to_vault_update_id), None)
            .await
            .map_err(server_error)
    }
}

pub async fn send_update_over_websocket(
    update: &WebSocketServerMessage,
    sender: &mut SplitSink<WebSocket, Message>,
) -> Result<(), SyncServerError> {
    let serialized_update = serde_json::to_string(update)
        .context("Failed to serialize update")
        .map_err(server_error)?;

    sender
        .send(Message::Text(serialized_update))
        .await
        .context("Failed to send message over websocket")
        .map_err(server_error)
}
