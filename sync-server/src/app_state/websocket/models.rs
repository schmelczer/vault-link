use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::app_state::database::models::{
    DeviceId, DocumentId, DocumentVersionWithoutContent, VaultUpdateId,
};

#[derive(TS, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketHandshake {
    pub token: String,
    pub device_id: DeviceId,

    #[ts(type = "number | null")]
    pub last_seen_vault_update_id: Option<VaultUpdateId>,
}

#[derive(TS, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CursorPositionFromClient {
    pub documents_with_cursors: Vec<DocumentWithCursors>,
}

#[derive(TS, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWithCursors {
    // It's None in case the document is dirty.
    // We still want to sync the cursor to mark
    // that it exists and can be client-side
    // interpolated. However, the actual
    // position is meaningless.
    #[ts(type = "number | null")]
    pub vault_update_id: Option<VaultUpdateId>,

    pub document_id: DocumentId,
    pub relative_path: String,
    pub cursors: Vec<CursorSpan>,
}

#[derive(TS, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CursorSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(TS, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClientCursors {
    pub user_name: String,
    pub device_id: DeviceId,
    pub documents_with_cursors: Vec<DocumentWithCursors>,
}

#[derive(TS, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CursorPositionFromServer {
    pub clients: Vec<ClientCursors>,
}

// Clients only get notified of other clients' updates through WebSocketVaultUpdate.
#[derive(TS, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketVaultUpdate {
    pub documents: Vec<DocumentVersionWithoutContent>,
    pub is_initial_sync: bool,
}

// Clients get notified of both their own and other clients' path changes through WebSocketVaultPathChange.
// This is becuase we must absolutely order path updates as they may all depend on all previous updates.
#[derive(TS, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketVaultPathChange {
    #[ts(type = "number")]
    pub vault_update_id: VaultUpdateId,
    pub document_id: DocumentId,
    pub relative_path: String,
}

#[derive(TS, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum WebSocketClientMessage {
    Handshake(WebSocketHandshake),
    CursorPositions(CursorPositionFromClient),
}

#[derive(TS, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum WebSocketServerMessage {
    VaultUpdate(WebSocketVaultUpdate),
    PathChange(WebSocketVaultPathChange),
    CursorPositions(CursorPositionFromServer),
}

#[derive(Clone, Debug)]
pub struct WebSocketServerMessageWithOrigin {
    pub origin_device_id: Option<DeviceId>,
    pub message: WebSocketServerMessage,
}

impl WebSocketServerMessageWithOrigin {
    pub fn new(message: WebSocketServerMessage) -> Self {
        Self {
            origin_device_id: None,
            message,
        }
    }

    pub fn with_origin(origin_device_id: DeviceId, message: WebSocketServerMessage) -> Self {
        Self {
            origin_device_id: Some(origin_device_id),
            message,
        }
    }
}
