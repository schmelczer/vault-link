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
};
use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures::StreamExt;
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

    let Some(permit) = state.broadcasts.try_admit(&vault_id) else {
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            "Vault connection limit reached",
        )
            .into_response());
    };
    Ok(ws
        .max_message_size(1024 * 1024)
        .max_frame_size(1024 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            if let Err(error) = websocket(state, socket, vault_id).await {
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
        tokio::time::timeout(Duration::from_secs(5), receiver.next())
            .await
            .map_err(|_| client_error(anyhow::anyhow!("WebSocket handshake deadline expired")))?
            .transpose()
            .unwrap_or_default(),
    )?;

    let device = authenticated.handshake.device_id;
    let session = state.cursors.register_connection(&vault, &device).await;
    let mut last_checkpoint = None;
    let mut notifications = state.broadcasts.get_receiver(vault.clone()).await;
    let mut timer = tokio::time::interval(Duration::from_secs(2));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    info!("WebSocket connected to vault {vault}");

    // HTTP owns event replay. Poll the cheap checkpoint to recover missed
    // broadcasts, including a commit followed by an interrupted notification.
    let result = async {
        loop {
            let checkpoint = state.database.history_checkpoint(&vault).await.map_err(server_error)?;
            if last_checkpoint.as_ref() != Some(&checkpoint) {
                send_update_over_websocket(&WebSocketServerMessage::VaultChanged, &mut sender).await?;
                last_checkpoint = Some(checkpoint);
            }

            tokio::select! {
                _ = timer.tick() => {},
                notification = notifications.recv() => match notification {
                    Ok(update) => if let Notification::Cursors(mut positions) = update {
                        positions.clients.retain(|c| c.device_id != device);
                        send_update_over_websocket(&WebSocketServerMessage::CursorPositions(positions), &mut sender).await?;
                    },

                    Err(RecvError::Lagged(_)) => {}, // Check the durable head on the next iteration.
                    Err(RecvError::Closed) => break,
                },

                incoming = receiver.next() => match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let message: WebSocketClientMessage = serde_json::from_str(&text).map_err(|error| client_error(error.into()))?;
                        match message {
                            WebSocketClientMessage::Handshake(_) => return Err(client_error(anyhow::anyhow!("Unexpected handshake"))),
                            WebSocketClientMessage::CursorPositions(positions) => {
                                state.cursors.update_cursors(vault.clone(), authenticated.user.name.clone(), &device, session, positions.documents_with_cursors).await;
                                let clients = state.cursors.get_cursors(&vault).await.into_iter().filter(|c| c.device_id != device).collect();
                                send_update_over_websocket(&WebSocketServerMessage::CursorPositions(CursorPositionFromServer { clients }), &mut sender).await?;
                            }
                        }
                    },
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                    _ => break,
                }
            }
        }

        Ok(())
    }.await;

    state
        .cursors
        .remove_cursors_of_device(&vault, &device, session)
        .await;

    result
}
