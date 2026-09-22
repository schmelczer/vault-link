use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::app_state::database::models::{DeviceId, DocumentId, VaultUpdateId};

#[derive(TS, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketHandshake {
    pub token: String,
    pub device_id: DeviceId,
}

#[derive(TS, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CursorPositionFromClient {
    pub documents_with_cursors: Vec<DocumentWithCursors>,
}

#[derive(TS, Serialize, Deserialize, Clone, Debug)]
pub struct DocumentWithCursors {
    // It's None in case the document is dirty.
    // We still want to sync the cursor to mark
    // that it exists and can be client-side
    // interpolated. However, the actual
    // position is meaningless.
    #[ts(as = "Option<u32>")]
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
    VaultChanged,
    CursorPositions(CursorPositionFromServer),
}
