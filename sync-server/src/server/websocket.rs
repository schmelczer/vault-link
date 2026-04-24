use crate::{
    app_state::{
        AppState,
        database::models::VaultId,
        websocket::{
            models::{
                CursorPositionFromServer, WebSocketClientMessage, WebSocketServerMessage,
                WebSocketVaultUpdate,
            },
            utils::{
                get_authenticated_handshake, get_unseen_documents, send_update_over_websocket,
            },
        },
    },
    consts::{
        HANDSHAKE_TIMEOUT, MAX_CURSOR_DOCUMENTS, MAX_CURSORS_PER_DOCUMENT, MAX_RELATIVE_PATH_LEN,
    },
    errors::{SyncServerError, client_error, server_error},
    utils::normalize::normalize,
};
use anyhow::Context;
use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use futures::sink::SinkExt;
use futures::stream::StreamExt;
use log::{debug, info, warn};
use serde::Deserialize;

/// Tracks a pending (not yet authenticated) WebSocket connection.
/// Decrements the counter when dropped, ensuring cleanup even if
/// the upgrade never completes or auth fails.
struct PendingWsGuard(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Drop for PendingWsGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

#[derive(Deserialize)]
pub struct WebSocketPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
}

pub async fn websocket_handler(
    ws: WebSocketUpgrade,
    Path(WebSocketPathParams { vault_id }): Path<WebSocketPathParams>,
    State(state): State<AppState>,
) -> Result<Response, SyncServerError> {
    let current = state
        .pending_ws_connections
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if current >= state.config.server.max_pending_websocket_connections {
        state
            .pending_ws_connections
            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        return Err(client_error(anyhow::anyhow!(
            "Too many pending WebSocket connections"
        )));
    }

    let guard = PendingWsGuard(state.pending_ws_connections.clone());
    Ok(ws.on_upgrade(move |socket| websocket_wrapped(state, socket, vault_id, guard)))
}

async fn websocket_wrapped(
    state: AppState,
    stream: WebSocket,
    vault_id: VaultId,
    pending_guard: PendingWsGuard,
) {
    info!("WebSocket connection opened on vault `{vault_id}`");

    let result = websocket(state, stream, vault_id.clone(), pending_guard).await;

    if let Err(err) = result {
        debug!("WebSocket connection error on vault `{vault_id}`: {err}");
    }
}

#[allow(clippy::too_many_lines)]
async fn websocket(
    state: AppState,
    stream: WebSocket,
    vault_id: VaultId,
    pending_guard: PendingWsGuard,
) -> Result<(), SyncServerError> {
    let (mut sender, mut websocket_receiver) = stream.split();

    let handshake_msg = tokio::time::timeout(HANDSHAKE_TIMEOUT, websocket_receiver.next())
        .await
        .map_err(|_| client_error(anyhow::anyhow!("WebSocket handshake timed out")))?
        .transpose()
        .map_err(|e| client_error(anyhow::anyhow!("WebSocket error during handshake: {e}")))?;

    let authed_handshake = get_authenticated_handshake(&state, &vault_id, handshake_msg)?;

    info!(
        "WebSocket handshake successful for vault `{vault_id}` for `{}`",
        authed_handshake.handshake.device_id
    );

    // Auth complete — no longer a pending connection.
    drop(pending_guard);

    let max_clients = state.config.server.max_clients_per_vault;
    let mut broadcast_receiver = match state.broadcasts.get_receiver(vault_id.clone(), max_clients)
    {
        Ok(receiver) => receiver,
        Err(err) => {
            warn!(
                "Vault `{vault_id}` has reached the maximum number of clients ({max_clients}), rejecting connection from `{}`",
                authed_handshake.handshake.device_id
            );
            if let Err(e) = sender
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 4000,
                    reason: format!(
                        "Vault has reached the maximum number of clients ({max_clients})"
                    )
                    .into(),
                })))
                .await
            {
                warn!("Failed to send WebSocket close frame: {e}");
            }
            return Err(err);
        }
    };

    // Catch-up on versions committed while this client was offline,
    // streamed one-at-a-time in ascending `vault_update_id` order
    let unseen_documents = get_unseen_documents(
        &state,
        &vault_id,
        authed_handshake.handshake.last_seen_vault_update_id,
    )
    .await?;
    for document in unseen_documents {
        send_update_over_websocket(
            &WebSocketServerMessage::VaultUpdate(WebSocketVaultUpdate { document }),
            &mut sender,
        )
        .await?;
    }

    send_update_over_websocket(
        &WebSocketServerMessage::CursorPositions(CursorPositionFromServer {
            clients: state.cursors.get_cursors(&vault_id).await,
        }),
        &mut sender,
    )
    .await?;

    let device_id = authed_handshake.handshake.device_id.clone();
    let mut send_task = tokio::spawn(async move {
        loop {
            match broadcast_receiver.recv().await {
                Ok(update) => {
                    // Drop messages this device authored because the HTTP
                    // response already carried authoritative state back.
                    if Some(&device_id) == update.origin_device_id.as_ref() {
                        continue;
                    }

                    let message = match update.message {
                        WebSocketServerMessage::CursorPositions(CursorPositionFromServer {
                            clients,
                        }) => WebSocketServerMessage::CursorPositions(CursorPositionFromServer {
                            clients: clients
                                .into_iter()
                                .filter(|client| client.device_id != device_id)
                                .collect(),
                        }),
                        WebSocketServerMessage::VaultUpdate(_) => update.message,
                    };

                    send_update_over_websocket(&message, &mut sender).await?;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    warn!(
                        "WebSocket receiver lagged, dropped {n} messages — disconnecting client to force full resync"
                    );
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }

        Ok::<(), SyncServerError>(())
    });

    let device_id = authed_handshake.handshake.device_id.clone();
    let vault_id_clone = vault_id.clone();
    let cursor_manager = state.cursors.clone();
    let mut receive_task = tokio::spawn(async move {
        while let Some(msg) = websocket_receiver.next().await {
            match msg {
                Ok(Message::Text(message)) => {
                    let message: WebSocketClientMessage = serde_json::from_str(&message)
                        .context("Failed to parse WebSocket message from client")
                        .map_err(client_error)?;

                    match message {
                        WebSocketClientMessage::Handshake(_) => {
                            return Err(client_error(anyhow::anyhow!(
                                "Unexpected handshake message"
                            )));
                        }
                        WebSocketClientMessage::CursorPositions(cursors) => {
                            let docs = cursors.documents_with_cursors;
                            if docs.len() > MAX_CURSOR_DOCUMENTS {
                                warn!(
                                    "Cursor update rejected: {} documents exceeds limit of {MAX_CURSOR_DOCUMENTS}",
                                    docs.len()
                                );
                                continue;
                            }

                            let valid = docs.iter().all(|doc| {
                                doc.cursors.len() <= MAX_CURSORS_PER_DOCUMENT
                                    && doc.relative_path.len() <= MAX_RELATIVE_PATH_LEN
                            });
                            if !valid {
                                warn!(
                                    "Cursor update rejected: a document exceeds cursor or path length limits"
                                );
                                continue;
                            }

                            cursor_manager
                                .update_cursors(
                                    vault_id_clone.clone(),
                                    authed_handshake.user.name.clone(),
                                    &device_id,
                                    docs,
                                )
                                .await;
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Binary(_)) => {
                    warn!("Received unexpected binary WebSocket message, ignoring");
                }
                Ok(_) => {} // Ping/Pong frames handled by axum
                Err(e) => {
                    debug!("WebSocket receive error: {e}");
                    break;
                }
            }
        }

        Ok::<(), SyncServerError>(())
    });

    let result: Result<(), SyncServerError> = tokio::select! {
        send_result = &mut send_task => {
            receive_task.abort();
            let _ = receive_task.await;
            match send_result {
                Err(e) => Err(server_error(
                    anyhow::Error::from(e).context("WebSocket send task failed"),
                )),
                Ok(inner) => inner,
            }
        },
        receive_result = &mut receive_task => {
            send_task.abort();
            let _ = send_task.await;
            match receive_result {
                Err(e) => Err(server_error(
                    anyhow::Error::from(e).context("WebSocket receive task failed"),
                )),
                Ok(inner) => inner,
            }
        },
    };

    state
        .cursors
        .remove_cursors_of_device(&vault_id, &authed_handshake.handshake.device_id)
        .await;

    match &result {
        Ok(()) => {
            info!(
                "WebSocket disconnected on vault `{vault_id}` for `{}`",
                authed_handshake.handshake.device_id
            );
        }
        Err(err) => {
            warn!(
                "WebSocket error on vault `{vault_id}` for `{}`: {err}",
                authed_handshake.handshake.device_id
            );
        }
    }

    result
}
