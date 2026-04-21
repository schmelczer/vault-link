use chrono::{DateTime, Utc};
use serde::{self, Serialize};
use ts_rs::TS;

use crate::app_state::database::models::{
    DocumentUpdateMergedContent, DocumentUpdateMetadata, DocumentVersionWithoutContent,
    VaultUpdateId,
};

/// Response to a ping request.
#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PingResponse {
    /// Semantic version of the server.
    pub server_version: String,

    /// Whether the client is authenticated based on the sent Authorization
    /// header.
    pub is_authenticated: bool,

    /// List of file extensions that are allowed to be merged.
    pub mergeable_file_extensions: Vec<String>,

    /// API version ensuring backwards & forwards compatibility between the client
    /// and server.
    pub supported_api_version: u32,
}

/// Response to a fetch latest documents request.
#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FetchLatestDocumentsResponse {
    pub latest_documents: Vec<DocumentVersionWithoutContent>,

    /// The update ID of the latest document in the response.
    pub last_update_id: VaultUpdateId,
}

/// Response to a vault history request (paginated).
#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VaultHistoryResponse {
    pub versions: Vec<DocumentVersionWithoutContent>,
    pub has_more: bool,
}

/// Summary of a single vault returned by the list-vaults endpoint.
#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VaultInfo {
    pub name: String,
    pub document_count: u32,
    pub created_at: Option<DateTime<Utc>>,
}

/// Response to listing vaults accessible to the authenticated user.
#[derive(TS, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ListVaultsResponse {
    pub vaults: Vec<VaultInfo>,
    pub has_more: bool,
    pub user_name: String,
}

/// Response to a create/update document request.
#[derive(TS, Debug, Clone, Serialize)]
#[serde(tag = "type")]
#[ts(export)]
pub enum DocumentUpdateResponse {
    /// Returned when the created/updated document's content is the same as was
    /// sent in the create/update request and thus the response doesn't contain
    /// the content because the client must already have it.
    FastForwardUpdate(DocumentUpdateMetadata),

    /// Returned when the created/updated document's content is different from
    /// what was sent in the create/update request.
    MergingUpdate(DocumentUpdateMergedContent),
}
