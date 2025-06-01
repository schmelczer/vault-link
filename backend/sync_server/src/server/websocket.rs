use anyhow::Context;
use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use futures::stream::StreamExt;
use log::{error, info, warn};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::{
    app_state::{
        AppState,
        database::models::VaultId,
        websocket::{
            models::{
                CursorPositionFromServer, WebSocketClientMessage, WebSocketServerMessage,
                WebSocketVaultUpdate,
            },
            utils::{get_handshake, get_unseen_documents, send_update_over_websocket},
        },
    },
    errors::{SyncServerError, client_error, server_error, unauthenticated_error},
    utils::normalize::normalize,
};

// This is required for aide to infer the path parameter types and names
#[derive(Deserialize, JsonSchema)]
pub struct WebSocketPathParams {
    #[serde(deserialize_with = "normalize")]
    vault_id: VaultId,
}

pub async fn websocket_handler(
    ws: WebSocketUpgrade,
    Path(WebSocketPathParams { vault_id }): Path<WebSocketPathParams>,
    State(state): State<AppState>,
) -> Result<Response, SyncServerError> {
    Ok(ws.on_upgrade(move |socket| websocket_wrapped(state, socket, vault_id)))
}

async fn websocket_wrapped(state: AppState, stream: WebSocket, vault_id: VaultId) {
    info!("WebSocket connection opened on vault '{vault_id}'");

    let result = websocket(state, stream, vault_id.clone()).await;

    if let Err(err) = result {
        error!("WebSocket connection error on vault '{vault_id}': {err}");
    }

    warn!("WebSocket connection closed on vault '{vault_id}'");
}

async fn websocket(
    state: AppState,
    stream: WebSocket,
    vault_id: VaultId,
) -> Result<(), SyncServerError> {
    let (mut sender, mut receiver) = stream.split();

    let handshake = if let Some(Ok(message)) = receiver.next().await {
        get_handshake(&state, &vault_id, message)?
    } else {
        return Err(unauthenticated_error(anyhow::anyhow!(
            "Failed to authenticate due to invalid message"
        )));
    };

    let mut rx = state.broadcasts.get_receiver(vault_id.clone()).await;

    send_update_over_websocket(
        &WebSocketServerMessage::VaultUpdate(WebSocketVaultUpdate {
            documents: get_unseen_documents(&state, &vault_id, handshake.last_seen_vault_update_id)
                .await?,
            is_initial_sync: true,
        }),
        &mut sender,
    )
    .await?;

    send_update_over_websocket(
        &WebSocketServerMessage::CursorPositions(CursorPositionFromServer {
            clients: state.cursors.get_cursors(&vault_id).await,
        }),
        &mut sender,
    )
    .await?;

    let device_id = handshake.device_id.clone();
    let mut send_task = tokio::spawn(async move {
        while let Ok(update) = rx.recv().await {
            if Some(&device_id) == update.origin_device_id.as_ref() {
                continue;
            }

            send_update_over_websocket(&update.message, &mut sender).await?;
        }

        Ok::<(), SyncServerError>(())
    });

    let device_id = handshake.device_id.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(Message::Text(message))) = receiver.next().await {
            let message: WebSocketClientMessage = serde_json::from_str(&message)
                .context("Failed to parse message")
                .map_err(server_error)?;

            match message {
                WebSocketClientMessage::Handshake(_) => {
                    return Err(client_error(anyhow::anyhow!(
                        "Unexpected handshake message"
                    )));
                }
                WebSocketClientMessage::CursorPositions(cursors) => {
                    state
                        .cursors
                        .update_cursors(vault_id.clone(), &device_id, cursors.document_to_cursors)
                        .await;
                }
            }
        }

        Ok::<(), SyncServerError>(())
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    };

    send_task
        .await
        .context("WebSocket send task failed")
        .map_err(server_error)??;

    recv_task
        .await
        .context("WebSocket receive task failed")
        .map_err(server_error)??;

    Ok(())
}
