use crate::app_state::database::models::VaultUpdateId;
use reconcile_text::NumberOrText;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(TS, Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "value")]
pub enum PushContent {
    Snapshot(String),
    Diff(#[ts(type = "Array<number | string>")] Vec<NumberOrText>),
    Delete,
}

#[derive(TS, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PushDocument {
    pub request_id: uuid::Uuid,
    #[ts(as = "Option<i32>")]
    pub parent_version_id: Option<VaultUpdateId>,
    pub relative_path: String,
    pub content: PushContent,
}
