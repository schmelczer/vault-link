use crate::{
    app_state::database::models::{DocumentId, FileManifestEntries, VaultUpdateId},
    utils::portable_path::validate_file_manifest,
};
use reconcile_text::NumberOrText;
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{Error, MapAccess, Visitor},
};
use std::{collections::BTreeMap, fmt};
use ts_rs::TS;

#[derive(TS, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct PutFileContent {
    pub request_id: uuid::Uuid,
    #[ts(as = "Option<f64>")]
    pub parent_version_id: Option<VaultUpdateId>,
    pub content: PushContent,
}

#[derive(TS, Debug, Deserialize, Serialize)]
#[serde(tag = "type", content = "value")]
#[serde(deny_unknown_fields)]
pub enum PushContent {
    Snapshot(String),
    Diff(#[ts(type = "Array<number | string>")] Vec<NumberOrText>),
}

#[derive(TS, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct PushFileManifest {
    pub request_id: uuid::Uuid,
    #[ts(as = "f64")]
    pub parent_file_manifest_id: VaultUpdateId,
    #[serde(deserialize_with = "deserialize_file_manifest_entries")]
    #[ts(type = "Record<string, string>")]
    pub entries: FileManifestEntries,
}

// A normal JSON map decoder silently overwrites duplicate keys. UUID parsing also
// catches differently spelled keys that denote the same identity.
fn deserialize_file_manifest_entries<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<FileManifestEntries, D::Error> {
    struct Entries;

    impl<'de> Visitor<'de> for Entries {
        type Value = FileManifestEntries;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("unique document IDs mapped to paths")
        }

        fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
            let mut entries = BTreeMap::new();

            while let Some((id, path)) = map.next_entry::<DocumentId, String>()? {
                if entries.insert(id, path).is_some() {
                    return Err(M::Error::custom("Duplicate document ID"));
                }
            }

            Ok(entries)
        }
    }

    let entries = d.deserialize_map(Entries)?;

    validate_file_manifest(&entries).map_err(D::Error::custom)?;

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::PushFileManifest;

    fn deserialize_manifest(entries: &str) -> serde_json::Result<PushFileManifest> {
        serde_json::from_str(&format!(
            r#"{{
                "requestId": "00000000-0000-0000-0000-000000000001",
                "parentFileManifestId": 0,
                "entries": {entries}
            }}"#
        ))
    }

    #[test]
    fn deserializes_empty_and_valid_file_manifests() {
        assert!(deserialize_manifest("{}").unwrap().entries.is_empty());

        let push = deserialize_manifest(
            r#"{
                "00000000-0000-0000-0000-000000000001": "Notes/Café.md",
                "00000000-0000-0000-0000-000000000002": "Notes/日記.md"
            }"#,
        )
        .unwrap();

        assert_eq!(
            push.entries
                .values()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["Notes/Café.md", "Notes/日記.md"]
        );
    }

    #[test]
    fn deserialization_rejects_invalid_paths_and_manifest_conflicts() {
        for (entries, expected_error) in [
            (
                r#"{"00000000-0000-0000-0000-000000000001": "../notes.md"}"#,
                "Invalid path component",
            ),
            (
                r#"{
                    "00000000-0000-0000-0000-000000000001": "Notes/a.md",
                    "00000000-0000-0000-0000-000000000002": "notes/b.md"
                }"#,
                "Conflicting path",
            ),
        ] {
            let error = deserialize_manifest(entries).unwrap_err();

            assert!(error.to_string().contains(expected_error), "{error}");
        }
    }

    #[test]
    fn deserialization_rejects_duplicate_document_ids_including_uuid_aliases() {
        let id = "00000000-0000-0000-0000-000000000abc";

        for duplicate in [id.to_owned(), id.to_uppercase()] {
            let entries = format!(r#"{{"{id}": "a.md", "{duplicate}": "b.md"}}"#);
            let error = deserialize_manifest(&entries).unwrap_err();

            assert!(
                error.to_string().contains("Duplicate document ID"),
                "{error}"
            );
        }
    }
}
