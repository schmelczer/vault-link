use axum::body::Bytes;
use axum_typed_multipart::{FieldData, TryFromMultipart};
use reconcile_text::NumberOrText;
use serde::{self, Deserialize};
use ts_rs::TS;

use crate::app_state::database::models::VaultUpdateId;

#[derive(TS, Debug, TryFromMultipart)]
#[ts(export)]
pub struct CreateDocumentVersion {
    pub relative_path: String,

    #[ts(as = "Vec<u8>")]
    #[form_data(limit = "unlimited")]
    pub content: FieldData<Bytes>,
}

#[derive(Debug, TryFromMultipart)]
pub struct UpdateBinaryDocumentVersion {
    pub parent_version_id: VaultUpdateId,
    pub relative_path: String,

    #[form_data(limit = "unlimited")]
    pub content: FieldData<Bytes>,
}

#[derive(TS, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateTextDocumentVersion {
    #[ts(type = "number")]
    pub parent_version_id: VaultUpdateId,

    pub relative_path: String,

    #[ts(type = "Array<number | string>")]
    pub content: Vec<NumberOrText>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteDocumentVersion {}
