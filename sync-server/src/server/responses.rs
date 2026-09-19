use serde::{self, Deserialize, Serialize};
use ts_rs::TS;

use crate::app_state::database::models::{
    DocumentVersion, DocumentVersionWithoutContent, FileManifest, VaultUpdateId,
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

/// Response to an update document request.
#[derive(TS, Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
#[ts(export)]
pub enum DocumentUpdateResponse {
    /// The exact snapshot was committed, or this is its original acknowledgement.
    Accepted(DocumentVersionWithoutContent),

    /// Nothing was written. The client must incorporate this version before retrying.
    StaleBase(DocumentVersion),
}

#[derive(TS, Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
#[ts(export)]
pub enum FileManifestUpdateResponse {
    Accepted {
        #[serde(rename = "fileManifestId")]
        #[ts(as = "f64")]
        file_manifest_id: VaultUpdateId,
    },
    StaleBase(FileManifest),
}
