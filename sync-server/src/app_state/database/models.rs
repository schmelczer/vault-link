use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

pub type VaultId = String;
pub type VaultUpdateId = i64;
pub type DocumentId = uuid::Uuid;
pub type UserId = String;
pub type DeviceId = String;
pub type FileManifestEntries = BTreeMap<DocumentId, String>;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct StoredDocumentVersion {
    pub vault_update_id: VaultUpdateId,
    #[sqlx(try_from = "uuid::fmt::Hyphenated")]
    pub document_id: DocumentId,
    pub updated_date: DateTime<Utc>,
    pub content: Vec<u8>,
    pub user_id: UserId,
    pub device_id: DeviceId,
}

#[derive(TS, Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DocumentVersionWithoutContent {
    #[ts(as = "f64")]
    pub vault_update_id: VaultUpdateId,
    #[sqlx(try_from = "uuid::fmt::Hyphenated")]
    pub document_id: DocumentId,
    pub updated_date: DateTime<Utc>,
    pub user_id: UserId,
    pub device_id: DeviceId,
    #[sqlx(try_from = "i64")]
    pub content_size: usize,
}

impl From<&StoredDocumentVersion> for DocumentVersionWithoutContent {
    fn from(v: &StoredDocumentVersion) -> Self {
        Self {
            vault_update_id: v.vault_update_id,
            document_id: v.document_id,
            updated_date: v.updated_date,
            user_id: v.user_id.clone(),
            device_id: v.device_id.clone(),
            content_size: v.content.len(),
        }
    }
}
impl From<StoredDocumentVersion> for DocumentVersionWithoutContent {
    fn from(v: StoredDocumentVersion) -> Self {
        Self::from(&v)
    }
}

#[derive(TS, Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DocumentVersion {
    #[serde(flatten)]
    pub metadata: DocumentVersionWithoutContent,
    pub content_base64: String,
}
impl From<StoredDocumentVersion> for DocumentVersion {
    fn from(v: StoredDocumentVersion) -> Self {
        Self {
            metadata: (&v).into(),
            content_base64: STANDARD.encode(&v.content),
        }
    }
}

#[derive(TS, Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileManifest {
    #[ts(as = "f64")]
    pub file_manifest_id: VaultUpdateId,
    #[ts(type = "Record<string, string>")]
    pub entries: FileManifestEntries,
}

#[derive(TS, Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum VaultEvent {
    Content {
        document: DocumentVersionWithoutContent,
    },
    FileManifest {
        #[serde(rename = "fileManifest")]
        #[ts(rename = "fileManifest")]
        file_manifest: FileManifest,
    },
}

#[derive(TS, Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EventRecord {
    #[ts(as = "f64")]
    pub event_id: VaultUpdateId,
    pub request_id: uuid::Uuid,
    #[serde(flatten)]
    pub event: VaultEvent,
}

#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VaultSnapshot {
    #[ts(as = "f64")]
    pub head_event_id: VaultUpdateId,
    pub file_manifest: FileManifest,
    pub documents: Vec<DocumentVersionWithoutContent>,
}

#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EventBatch {
    #[ts(as = "f64")]
    pub head_event_id: VaultUpdateId,
    /// Last event in this page; `head_event_id` is the vault's current head.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, as = "Option<f64>")]
    pub end_event_id: Option<VaultUpdateId>,
    pub events: Vec<EventRecord>,
}
