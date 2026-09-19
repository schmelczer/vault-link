use super::*;
use models::{DocumentId, EventRecord, FileManifest, StoredDocumentVersion, VaultEvent};

fn config(directory: &tempfile::TempDir) -> DatabaseConfig {
    DatabaseConfig {
        databases_directory_path: directory.path().to_owned(),
        ..Default::default()
    }
}

async fn insert_content(
    database: &Database,
    vault: &str,
    document_id: DocumentId,
    content: &[u8],
) -> StoredDocumentVersion {
    let mut tx = database
        .create_write_transaction(&vault.to_owned())
        .await
        .unwrap();
    let request_id = uuid::Uuid::new_v4();
    let version = StoredDocumentVersion {
        vault_update_id: Database::allocate_event(&mut tx, request_id, b"test")
            .await
            .unwrap(),
        document_id,
        updated_date: chrono::Utc::now(),
        content: content.to_vec(),
        user_id: "user".to_owned(),
        device_id: "device".to_owned(),
    };
    Database::insert_document_version(&mut tx, &version)
        .await
        .unwrap();
    Database::write_event(
        &mut tx,
        &EventRecord {
            event_id: version.vault_update_id,
            request_id,
            event: VaultEvent::Content {
                document: (&version).into(),
            },
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    version
}

#[tokio::test]
async fn unicode_vaults_remain_isolated_after_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(&directory);
    let database = Database::try_new(&config).await.unwrap();
    let document = uuid::Uuid::new_v4();
    let names = ["café", "cafe\u{301}", "σ", "ς"];

    for name in names {
        assert!(
            database
                .get_latest_document_version(&name.to_owned(), &document, None)
                .await
                .unwrap()
                .is_none()
        );
        insert_content(&database, name, document, name.as_bytes()).await;
    }

    let reopened = Database::try_new(&config).await.unwrap();
    for name in names {
        let version = reopened
            .get_latest_document_version(&name.to_owned(), &document, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(version.content, name.as_bytes());
    }
}

#[tokio::test]
async fn rejects_invalid_vault_names_at_the_database_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let config = DatabaseConfig {
        databases_directory_path: directory.path().join("databases"),
        ..Default::default()
    };
    let database = Database::try_new(&config).await.unwrap();
    for name in [
        "",
        " ",
        ".",
        "..",
        "../escaped",
        "/absolute",
        "a/b",
        "a\\b",
        "a\0b",
    ] {
        assert!(
            database.vault_snapshot(&name.to_owned()).await.is_err(),
            "accepted {name:?}"
        );
    }
    assert!(!directory.path().join("escaped.sqlite").exists());
    assert!(database.connection_pools.lock().await.is_empty());
}

#[tokio::test]
async fn snapshot_returns_latest_referenced_metadata_and_byte_lengths() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::try_new(&config(&directory)).await.unwrap();
    let vault = "snapshot".to_owned();
    let text_id = uuid::Uuid::new_v4();
    let binary_id = uuid::Uuid::new_v4();
    insert_content(&database, &vault, text_id, b"old").await;
    let binary = insert_content(&database, &vault, binary_id, &[0, 255, 0, 128]).await;
    let text = insert_content(&database, &vault, text_id, "café 🌍".as_bytes()).await;
    insert_content(&database, &vault, uuid::Uuid::new_v4(), b"unreferenced").await;

    let mut tx = database.create_write_transaction(&vault).await.unwrap();
    let request_id = uuid::Uuid::new_v4();
    let manifest = FileManifest {
        file_manifest_id: Database::allocate_event(&mut tx, request_id, b"manifest")
            .await
            .unwrap(),
        entries: [
            (text_id, "text.md".to_owned()),
            (binary_id, "binary.dat".to_owned()),
        ]
        .into(),
    };
    Database::insert_file_manifest(&mut tx, &manifest)
        .await
        .unwrap();
    Database::write_event(
        &mut tx,
        &EventRecord {
            event_id: manifest.file_manifest_id,
            request_id,
            event: VaultEvent::FileManifest {
                file_manifest: manifest.clone(),
            },
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let snapshot = database.vault_snapshot(&vault).await.unwrap();
    assert_eq!(snapshot.head_event_id, manifest.file_manifest_id);
    assert_eq!(snapshot.file_manifest.entries, manifest.entries);
    assert_eq!(snapshot.documents.len(), 2);
    for (actual, expected) in snapshot.documents.iter().zip([binary, text]) {
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(models::DocumentVersionWithoutContent::from(expected)).unwrap()
        );
    }
}
