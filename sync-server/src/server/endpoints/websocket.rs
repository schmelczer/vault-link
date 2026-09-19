use crate::{
    app_state::{
        AppState,
        database::models::VaultId,
        websocket::{
            broadcasts::Notification,
            models::{CursorPositionFromServer, WebSocketClientMessage, WebSocketServerMessage},
            utils::{get_authenticated_handshake, send_update_over_websocket},
        },
    },
    errors::{SyncServerError, client_error, server_error},
    utils::normalize::normalize,
};
use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use futures::StreamExt;
use log::{debug, info};
use serde::Deserialize;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;

#[derive(Deserialize)]
pub struct WebSocketPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
}

#[axum::debug_handler]
pub async fn websocket_handler(
    ws: WebSocketUpgrade,
    Path(path): Path<WebSocketPathParams>,
    State(state): State<AppState>,
) -> Result<Response, SyncServerError> {
    debug!(
        "Upgrading WebSocket connection for vault `{}`",
        path.vault_id
    );

    Ok(ws.on_upgrade(move |socket| async move {
        if let Err(error) = websocket(state, socket, path.vault_id).await {
            debug!("WebSocket disconnected: {error}");
        }
    }))
}

async fn websocket(
    state: AppState,
    socket: WebSocket,
    vault: VaultId,
) -> Result<(), SyncServerError> {
    let (mut sender, mut receiver) = socket.split();
    let authenticated = get_authenticated_handshake(
        &state,
        &vault,
        receiver.next().await.transpose().unwrap_or_default(),
    )?;

    let device = authenticated.handshake.device_id;
    let mut after = authenticated
        .handshake
        .last_seen_vault_update_id
        .unwrap_or(0);
    let mut notifications = state.broadcasts.get_receiver(vault.clone()).await;
    let mut timer = tokio::time::interval(Duration::from_secs(2));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    info!("WebSocket connected to vault {vault}");

    // Exactly one sender drains durable events in commit order. In-memory
    // notifications are only wakeups, so lag and commit/notify crashes are safe.
    let result = async {
        loop {
            let batch = state.database.events_after(&vault, after).await.map_err(|error| server_error(error.into()))?;

            if !batch.events.is_empty() {
                let head = batch.head_event_id;
                send_update_over_websocket(&WebSocketServerMessage::VaultEvents(batch), &mut sender).await?;
                after = head;
            }

            tokio::select! {
                _ = timer.tick() => {},
                notification = notifications.recv() => match notification {
                    Ok(update) => if let Notification::Cursors(mut positions) = update {
                        positions.clients.retain(|c| c.device_id != device);
                        send_update_over_websocket(&WebSocketServerMessage::CursorPositions(positions), &mut sender).await?;
                    },

                    Err(RecvError::Lagged(_)) => {}, // Drain the durable log on the next iteration.
                    Err(RecvError::Closed) => break,
                },

                incoming = receiver.next() => match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let message: WebSocketClientMessage = serde_json::from_str(&text).map_err(|error| client_error(error.into()))?;
                        match message {
                            WebSocketClientMessage::Handshake(_) => return Err(client_error(anyhow::anyhow!("Unexpected handshake"))),
                            WebSocketClientMessage::CursorPositions(positions) => {
                                state.cursors.update_cursors(vault.clone(), authenticated.user.name.clone(), &device, positions.documents_with_cursors).await;
                                let clients = state.cursors.get_cursors(&vault).await.into_iter().filter(|c| c.device_id != device).collect();
                                send_update_over_websocket(&WebSocketServerMessage::CursorPositions(CursorPositionFromServer { clients }), &mut sender).await?;
                            }
                        }
                    },
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                    _ => break,
                }
            }
        }
        
        Ok(())
    }.await;

    state
        .cursors
        .remove_cursors_of_device(&vault, &device)
        .await;

    result
}
