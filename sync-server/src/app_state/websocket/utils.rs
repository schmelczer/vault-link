use anyhow::Context;
use axum::extract::ws::{Message, WebSocket};
use futures::{sink::SinkExt, stream::SplitSink};

use super::models::{WebSocketClientMessage, WebSocketHandshake, WebSocketServerMessage};
use crate::{
    app_state::{AppState, database::models::VaultId},
    config::user_config::User,
    errors::{SyncServerError, server_error, unauthenticated_error},
    server::auth::auth,
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
            .map_err(server_error)?;

        match message {
            WebSocketClientMessage::Handshake(handshake) => {
                let user = auth(state, handshake.token.trim(), vault_id)?;
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
