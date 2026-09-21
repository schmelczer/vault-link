use super::*;
use models::{DocumentId, FileManifest, StoredDocumentVersion};

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
async fn migrations_can_be_reapplied_without_losing_requests_or_content() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(&directory);
    let database = Database::try_new(&config).await.unwrap();
    let vault = "migrations".to_owned();
    let version = insert_content(&database, &vault, uuid::Uuid::new_v4(), b"only copy").await;
    let pool = database.get_connection_pool(&vault).await.unwrap();
    Database::run_migrations(&pool).await.unwrap();
    Database::run_migrations(&pool).await.unwrap();
    let reopened = Database::try_new(&config).await.unwrap();
    assert_eq!(
        reopened
            .get_document_version(&vault, version.vault_update_id, None)
            .await
            .unwrap()
            .unwrap()
            .content,
        b"only copy"
    );
    assert_eq!(
        reopened.events_after(&vault, 0).await.unwrap().events.len(),
        1
    );
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

#[tokio::test]
async fn replay_pages_are_bounded_and_cover_every_event_in_order() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::try_new(&config(&directory)).await.unwrap();
    let vault = "pages".to_owned();
    let id = uuid::Uuid::new_v4();
    for _ in 0..150 {
        insert_content(&database, &vault, id, b"edit").await;
    }
    let mut after = 0;
    while after < 150 {
        let batch = database.events_after(&vault, after).await.unwrap();
        assert!(batch.events.len() <= 64, "catchup must bound each page");
        assert!(!batch.events.is_empty());
        assert_eq!(batch.head_event_id, 150);
        for event in batch.events {
            assert_eq!(event.event_id, after + 1);
            after = event.event_id;
        }
    }
    assert!(
        database
            .events_after(&vault, after)
            .await
            .unwrap()
            .events
            .is_empty()
    );
}

#[tokio::test]
async fn idle_cleanup_does_not_wait_for_an_active_vault() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::try_new(&config(&directory)).await.unwrap();
    database.vault_snapshot(&"other".to_owned()).await.unwrap();
    let vault = "slow".to_owned();
    let transaction = database.create_write_transaction(&vault).await.unwrap();
    database
        .connection_pools
        .lock()
        .await
        .get_mut(&vault)
        .unwrap()
        .last_accessed = Instant::now() - Duration::from_secs(301);
    tokio::time::timeout(Duration::from_millis(200), database.cleanup_idle_pools())
        .await
        .expect("cleanup must leave an active pool alone");
    let other = tokio::time::timeout(
        Duration::from_millis(200),
        database.vault_snapshot(&"other".to_owned()),
    )
    .await
    .expect("other vaults must remain accessible")
    .unwrap();
    assert_eq!(other.head_event_id, 0);
    assert!(
        !database
            .get_connection_pool(&vault)
            .await
            .unwrap()
            .is_closed()
    );
    drop(transaction);
}

#[tokio::test]
async fn manifest_existence_checks_are_independent_of_payload_decoding() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::try_new(&config(&directory)).await.unwrap();
    let vault = "existence".to_owned();
    let id = uuid::Uuid::new_v4();
    insert_content(&database, &vault, id, b"content").await;
    let mut tx = database.create_write_transaction(&vault).await.unwrap();
    // Make full-row deserialization fail: checking a foreign identity must not
    // decode unrelated version fields or read its potentially enormous blob.
    sqlx::query("UPDATE documents SET updated_date = 'unreadable timestamp'")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        Database::missing_document(&mut tx, &[id]).await.unwrap(),
        None
    );
    let missing = uuid::Uuid::new_v4();
    assert_eq!(
        Database::missing_document(&mut tx, &[id, missing])
            .await
            .unwrap(),
        Some(missing.to_string())
    );
    assert_eq!(
        Database::missing_document(&mut tx, &[]).await.unwrap(),
        None
    );
}

#[tokio::test]
async fn replay_byte_budget_prevents_accumulating_large_historical_manifests() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::try_new(&config(&directory)).await.unwrap();
    let vault = "large-manifests".to_owned();
    let mut tx = database.create_write_transaction(&vault).await.unwrap();
    // Each event fits independently, but fewer than 64 fit the response budget.
    let entries: std::collections::BTreeMap<_, _> = (0..1500)
        .map(|index| {
            (
                uuid::Uuid::new_v4(),
                format!("{index}-{}.md", "x".repeat(180)),
            )
        })
        .collect();
    for _ in 0..8 {
        let file_manifest_id = Database::allocate_event(&mut tx, uuid::Uuid::new_v4(), b"test")
            .await
            .unwrap();
        Database::insert_file_manifest(
            &mut tx,
            &FileManifest {
                file_manifest_id,
                entries: entries.clone(),
            },
        )
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    let batch = database.events_after(&vault, 0).await.unwrap();
    assert!(!batch.events.is_empty());
    assert!(batch.events.len() < 8);
    assert!(serde_json::to_vec(&batch).unwrap().len() < 1024 * 1024 + 1024);
    assert_eq!(
        batch.end_event_id,
        batch.events.last().map(|event| event.event_id)
    );
}

#[tokio::test]
async fn opening_a_locked_vault_does_not_block_unrelated_vaults() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(&directory);
    let database = Database::try_new(&config).await.unwrap();
    database.vault_snapshot(&"other".to_owned()).await.unwrap();
    let vault = "locked-opening".to_owned();
    // A second process holds the writer lock while this process lazily checks
    // migrations. Even already-open, unrelated vaults must remain available.
    let external = Database::open_database(&config, &Database::database_path(&config, &vault))
        .await
        .unwrap();
    let transaction = external.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let opening_database = database.clone();
    let opening = tokio::spawn(async move { opening_database.get_connection_pool(&vault).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let opening_is_blocked = !opening.is_finished();
    let other = tokio::time::timeout(
        Duration::from_millis(300),
        database.vault_snapshot(&"other".to_owned()),
    )
    .await;
    transaction.rollback().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), opening)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    external.close().await;
    assert!(
        opening_is_blocked,
        "the test must exercise an in-progress database open"
    );
    assert_eq!(
        other
            .expect("a blocked migration must not lock every vault")
            .unwrap()
            .head_event_id,
        0
    );
}

#[tokio::test]
async fn concurrent_vault_opens_share_a_pool_and_cancelled_opens_can_retry() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = config(&directory);
    config.max_connections_per_vault = 1;
    let database = Database::try_new(&config).await.unwrap();
    let vault = "cancelled-opening".to_owned();
    let external = Database::open_database(&config, &Database::database_path(&config, &vault))
        .await
        .unwrap();
    let transaction = external.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let opener = database.clone();
    let name = vault.clone();
    let cancelled = tokio::spawn(async move { opener.get_connection_pool(&name).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!cancelled.is_finished());
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    transaction.rollback().await.unwrap();
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let database = database.clone();
        let vault = vault.clone();
        tasks.push(tokio::spawn(async move {
            database.get_connection_pool(&vault).await.unwrap()
        }));
    }
    let pools = tokio::time::timeout(Duration::from_secs(5), futures::future::join_all(tasks))
        .await
        .unwrap();
    let pools: Vec<_> = pools.into_iter().map(Result::unwrap).collect();
    let checked_out = pools[0].acquire().await.unwrap();
    for pool in &pools[1..] {
        assert!(
            tokio::time::timeout(Duration::from_millis(25), pool.acquire())
                .await
                .is_err(),
            "all callers must share the single configured connection"
        );
    }
    drop(checked_out);
    external.close().await;
}

#[tokio::test]
async fn one_corrupt_vault_does_not_prevent_startup_or_healthy_vault_access() {
    let directory = tempfile::tempdir().unwrap();
    let config = config(&directory);
    let bad = Database::database_path(&config, "broken");
    tokio::fs::create_dir_all(bad.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&bad, b"not a SQLite database")
        .await
        .unwrap();
    let database = Database::try_new(&config).await.unwrap();
    assert!(database.vault_snapshot(&"broken".to_owned()).await.is_err());
    let saved = insert_content(&database, "healthy", uuid::Uuid::new_v4(), b"safe").await;
    assert_eq!(saved.content, b"safe");
    assert_eq!(
        tokio::fs::read(bad).await.unwrap(),
        b"not a SQLite database"
    );
}
