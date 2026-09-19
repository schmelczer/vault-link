pub mod events;
pub mod fetch_document_version_content;
pub mod fetch_latest_document_version;
pub mod get_file_manifest;
pub mod index;
pub mod method_not_allowed;
pub mod not_found;
pub mod ping;
pub mod put_file_content;
pub mod put_file_manifest;
mod utils;
pub mod vault_snapshot;
pub mod websocket;

use serde::{Deserialize, Deserializer};

use crate::{app_state::database::models::VaultId, utils::normalize_vault_id::normalize_vault_id};

#[derive(Debug)]
pub struct VaultPath(pub VaultId);

impl<'de> Deserialize<'de> for VaultPath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        normalize_vault_id(deserializer).map(Self)
    }
}
