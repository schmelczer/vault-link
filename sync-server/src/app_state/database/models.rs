use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde::Serialize;
use ts_rs::TS;

pub type VaultId = String;
pub type VaultUpdateId = i64;

pub type DocumentId = uuid::Uuid;
pub type UserId = String;
pub type DeviceId = String;

#[derive(Debug, Clone)]
pub struct StoredDocumentVersion {
    pub vault_update_id: VaultUpdateId,
    pub creation_vault_update_id: VaultUpdateId,
    pub document_id: DocumentId,
    pub relative_path: String,
    pub updated_date: DateTime<Utc>,
    pub content: Vec<u8>,
    pub is_deleted: bool,
    pub user_id: UserId,
    pub device_id: DeviceId,
    #[allow(dead_code)] // This is for manual analysis
    pub has_been_merged: bool,
}

impl PartialEq<Self> for StoredDocumentVersion {
    fn eq(&self, other: &Self) -> bool {
        self.vault_update_id == other.vault_update_id
    }
}

#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersionWithoutContent {
    #[ts(type = "number")]
    pub vault_update_id: VaultUpdateId,

    pub document_id: DocumentId,
    pub relative_path: String,
    pub updated_date: DateTime<Utc>,
    pub is_deleted: bool,
    pub user_id: UserId,
    pub device_id: DeviceId,

    #[ts(type = "number")]
    pub content_size: u64,
}

impl From<StoredDocumentVersion> for DocumentVersionWithoutContent {
    fn from(value: StoredDocumentVersion) -> Self {
        Self {
            vault_update_id: value.vault_update_id,
            document_id: value.document_id,
            relative_path: value.relative_path,
            updated_date: value.updated_date,
            is_deleted: value.is_deleted,
            user_id: value.user_id,
            device_id: value.device_id,
            content_size: value.content.len() as u64,
        }
    }
}

#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    #[ts(type = "number")]
    pub vault_update_id: VaultUpdateId,

    pub document_id: DocumentId,
    pub relative_path: String,
    pub updated_date: DateTime<Utc>,
    pub content_base64: String,
    pub is_deleted: bool,
    pub user_id: UserId,
    pub device_id: DeviceId,
}

/// Like [`DocumentVersionWithoutContent`] but without the `relative_path`.
/// Used only in create/update responses where the client already tracks
/// the path locally (the server is the source of truth for the
/// document identity, not its path).
#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUpdateMetadata {
    #[ts(type = "number")]
    pub vault_update_id: VaultUpdateId,

    pub document_id: DocumentId,
    pub updated_date: DateTime<Utc>,
    pub is_deleted: bool,
    pub user_id: UserId,
    pub device_id: DeviceId,

    #[ts(type = "number")]
    pub content_size: u64,
}

impl From<StoredDocumentVersion> for DocumentUpdateMetadata {
    fn from(value: StoredDocumentVersion) -> Self {
        Self {
            vault_update_id: value.vault_update_id,
            document_id: value.document_id,
            updated_date: value.updated_date,
            is_deleted: value.is_deleted,
            user_id: value.user_id,
            device_id: value.device_id,
            content_size: value.content.len() as u64,
        }
    }
}

/// Like [`DocumentVersion`] but without the `relative_path`.
/// Used only in create/update responses when the server had to merge the
/// client's content with a newer remote version and therefore must echo
/// the merged content back.
#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUpdateMergedContent {
    #[ts(type = "number")]
    pub vault_update_id: VaultUpdateId,

    pub document_id: DocumentId,
    pub updated_date: DateTime<Utc>,
    pub content_base64: String,
    pub is_deleted: bool,
    pub user_id: UserId,
    pub device_id: DeviceId,
}

impl From<StoredDocumentVersion> for DocumentUpdateMergedContent {
    fn from(value: StoredDocumentVersion) -> Self {
        Self {
            vault_update_id: value.vault_update_id,
            document_id: value.document_id,
            updated_date: value.updated_date,
            content_base64: STANDARD.encode(&value.content),
            is_deleted: value.is_deleted,
            user_id: value.user_id,
            device_id: value.device_id,
        }
    }
}

/// Row struct for vault history queries (used by `sqlx::query_as!`)
#[derive(Debug)]
pub struct VaultHistoryRow {
    pub vault_update_id: VaultUpdateId,
    pub document_id: DocumentId,
    pub relative_path: String,
    pub updated_date: DateTime<Utc>,
    pub is_deleted: bool,
    pub user_id: String,
    pub device_id: String,
    pub content_size: Option<u64>,
}

pub struct VaultStats {
    pub created_at: Option<DateTime<Utc>>,
    pub document_count: u32,
}

impl From<StoredDocumentVersion> for DocumentVersion {
    fn from(value: StoredDocumentVersion) -> Self {
        Self {
            vault_update_id: value.vault_update_id,
            document_id: value.document_id,
            relative_path: value.relative_path,
            updated_date: value.updated_date,
            content_base64: STANDARD.encode(&value.content),
            is_deleted: value.is_deleted,
            user_id: value.user_id,
            device_id: value.device_id,
        }
    }
}
