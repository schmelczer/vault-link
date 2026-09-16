use std::path::PathBuf;

use super::*;
use crate::{
    app_state::{
        database::models::{DocumentVersionWithoutContent, VaultUpdateId},
        websocket::broadcasts::Broadcasts,
    },
    config::{database_config::DatabaseConfig, server_config::ServerConfig},
};

struct Push {
    document_id: DocumentId,
    request_id: uuid::Uuid,
    parent_version_id: Option<VaultUpdateId>,
    relative_path: String,
    content: PushContent,
    user_id: String,
    device_id: String,
}

impl Push {
    async fn send(
        self,
        database: &Database,
        vault: &VaultId,
    ) -> Result<DocumentUpdateResponse, SyncServerError> {
        accept_push(
            database,
            vault,
            self.document_id,
            self.user_id,
            self.device_id,
            PushDocument {
                request_id: self.request_id,
                parent_version_id: self.parent_version_id,
                relative_path: self.relative_path,
                content: self.content,
            },
        )
        .await
    }
}

struct TestVault {
    directory: PathBuf,
    database: Database,
    vault: VaultId,
}

impl TestVault {
    async fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("vaultlink-cas-{}", uuid::Uuid::new_v4()));
        let database = Self::open(&directory).await;
        Self {
            directory,
            database,
            vault: "test".to_owned(),
        }
    }

    async fn open(directory: &std::path::Path) -> Database {
        Database::try_new(
            &DatabaseConfig {
                databases_directory_path: directory.to_owned(),
                ..Default::default()
            },
            &Broadcasts::new(&ServerConfig {
                max_clients_per_vault: 16,
                ..Default::default()
            }),
        )
        .await
        .unwrap()
    }

    async fn send(&self, push: Push) -> DocumentUpdateResponse {
        push.send(&self.database, &self.vault).await.unwrap()
    }

    async fn latest(&self, document: DocumentId) -> StoredDocumentVersion {
        self.database
            .get_latest_document(&self.vault, &document, None)
            .await
            .unwrap()
            .unwrap()
    }
}

impl Drop for TestVault {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn snapshot(document_id: DocumentId, parent: Option<VaultUpdateId>, text: &str) -> Push {
    Push {
        document_id,
        request_id: uuid::Uuid::new_v4(),
        parent_version_id: parent,
        relative_path: "note.md".to_owned(),
        content: PushContent::Snapshot(STANDARD.encode(text)),
        user_id: "user".to_owned(),
        device_id: "device".to_owned(),
    }
}

fn accepted(response: DocumentUpdateResponse) -> DocumentVersionWithoutContent {
    match response {
        DocumentUpdateResponse::Accepted(version) => version,
        response @ DocumentUpdateResponse::StaleBase(_) => {
            panic!("Expected Accepted, got {response:?}")
        }
    }
}

#[tokio::test]
async fn json_snapshot_preserves_bytes_and_rejects_invalid_base64_without_a_version() {
    let vault = TestVault::new().await;
    let document = uuid::Uuid::new_v4();
    let content = [0, 255, 13, 10, 42];
    let request: PushDocument = serde_json::from_value(serde_json::json!({
        "requestId": uuid::Uuid::new_v4(),
        "parentVersionId": null,
        "relativePath": "snapshot.bin",
        "content": { "type": "Snapshot", "value": STANDARD.encode(content) },
    }))
    .unwrap();
    let base = accepted(
        accept_push(
            &vault.database,
            &vault.vault,
            document,
            "user".to_owned(),
            "device".to_owned(),
            request,
        )
        .await
        .unwrap(),
    );
    assert_eq!(vault.latest(document).await.content, content);

    let invalid: PushDocument = serde_json::from_value(serde_json::json!({
        "requestId": uuid::Uuid::new_v4(),
        "parentVersionId": base.vault_update_id,
        "relativePath": "snapshot.bin",
        "content": { "type": "Snapshot", "value": "not base64!" },
    }))
    .unwrap();
    assert!(matches!(
        accept_push(
            &vault.database,
            &vault.vault,
            document,
            "user".to_owned(),
            "device".to_owned(),
            invalid
        )
        .await,
        Err(SyncServerError::ClientError(_))
    ));
    assert_eq!(
        vault.latest(document).await.vault_update_id,
        base.vault_update_id
    );
}

#[tokio::test]
async fn concurrent_writers_only_accept_one_snapshot_and_preserve_the_base() {
    let vault = TestVault::new().await;
    let document = uuid::Uuid::new_v4();
    let base = accepted(vault.send(snapshot(document, None, "base")).await);
    let (left, right) = tokio::join!(
        vault.send(snapshot(document, Some(base.vault_update_id), "left")),
        vault.send(snapshot(document, Some(base.vault_update_id), "right")),
    );
    let (winner, rejected) = match (left, right) {
        (DocumentUpdateResponse::Accepted(winner), DocumentUpdateResponse::StaleBase(rejected))
        | (DocumentUpdateResponse::StaleBase(rejected), DocumentUpdateResponse::Accepted(winner)) => {
            (winner, rejected)
        }
        outcomes => panic!("Expected one accepted push and one stale base: {outcomes:?}"),
    };
    let latest = vault.latest(document).await;
    assert_eq!(winner.vault_update_id, rejected.vault_update_id);
    assert_eq!(
        STANDARD.decode(rejected.content_base64).unwrap(),
        latest.content
    );
    assert!(latest.content == b"left" || latest.content == b"right");
    let original = vault
        .database
        .get_document_version(&vault.vault, base.vault_update_id, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.content, b"base");
    assert_eq!(
        vault
            .database
            .get_max_update_id_in_vault(&vault.vault, None)
            .await
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn acknowledgements_survive_reopening_and_return_the_original_version() {
    let vault = TestVault::new().await;
    let document = uuid::Uuid::new_v4();
    let create = snapshot(document, None, "created");
    let create_id = create.request_id;
    let base = accepted(vault.send(create).await);
    let update = snapshot(document, Some(base.vault_update_id), "updated");
    let update_id = update.request_id;
    let updated = accepted(vault.send(update).await);
    let latest = accepted(
        vault
            .send(snapshot(document, Some(updated.vault_update_id), "newest"))
            .await,
    );

    let reopened = TestVault::open(&vault.directory).await;
    for (request_id, parent, text, original) in [
        (create_id, None, "created", base),
        (update_id, Some(1), "updated", updated),
    ] {
        let mut retry = snapshot(document, parent, text);
        retry.request_id = request_id;
        retry.device_id = "new-session-after-restart".to_owned();
        let acknowledged = accepted(retry.send(&reopened, &vault.vault).await.unwrap());
        assert_eq!(
            serde_json::to_value(acknowledged).unwrap(),
            serde_json::to_value(original).unwrap()
        );
    }
    assert_eq!(
        vault.latest(document).await.vault_update_id,
        latest.vault_update_id
    );

    let mut reused = snapshot(uuid::Uuid::new_v4(), None, "wrong document");
    reused.request_id = create_id;
    assert!(matches!(
        reused.send(&reopened, &vault.vault).await,
        Err(SyncServerError::ClientError(_))
    ));

    let mut changed_path = snapshot(document, None, "created");
    changed_path.relative_path = "other.md".to_owned();
    let mut changed_operation = snapshot(document, None, "created");
    changed_operation.content = PushContent::Delete;
    for mut changed_payload in [
        snapshot(document, None, "different content"),
        snapshot(document, Some(1), "created"),
        changed_path,
        changed_operation,
    ] {
        changed_payload.request_id = create_id;
        assert!(matches!(
            changed_payload.send(&reopened, &vault.vault).await,
            Err(SyncServerError::ClientError(_))
        ));
    }
}

#[tokio::test]
async fn deletes_compare_the_base_and_replay_without_resurrecting_documents() {
    let vault = TestVault::new().await;
    let document = uuid::Uuid::new_v4();
    let base = accepted(vault.send(snapshot(document, None, "base")).await);
    let updated = accepted(
        vault
            .send(snapshot(document, Some(base.vault_update_id), "edited"))
            .await,
    );
    let mut delete = snapshot(document, Some(base.vault_update_id), "");
    delete.content = PushContent::Delete;
    assert!(matches!(
        vault.send(delete).await,
        DocumentUpdateResponse::StaleBase(_)
    ));
    assert!(!vault.latest(document).await.is_deleted);

    let mut delete = snapshot(document, Some(updated.vault_update_id), "");
    delete.content = PushContent::Delete;
    let request_id = delete.request_id;
    let deleted = accepted(vault.send(delete).await);
    assert!(deleted.is_deleted);
    assert_eq!(vault.latest(document).await.content, b"edited");
    let mut retry = snapshot(document, Some(updated.vault_update_id), "");
    retry.content = PushContent::Delete;
    retry.request_id = request_id;
    assert_eq!(
        accepted(vault.send(retry).await).vault_update_id,
        deleted.vault_update_id
    );

    let terminal = vault
        .send(snapshot(
            document,
            Some(deleted.vault_update_id),
            "resurrect",
        ))
        .await;
    assert!(matches!(terminal, DocumentUpdateResponse::StaleBase(version) if version.is_deleted));
    let recreated = accepted(
        vault
            .send(snapshot(uuid::Uuid::new_v4(), None, "new identity"))
            .await,
    );
    assert_eq!(recreated.relative_path, "note.md");
}

#[tokio::test]
async fn deleting_a_missing_document_without_a_parent_is_a_client_error() {
    let vault = TestVault::new().await;
    let document = uuid::Uuid::new_v4();
    let mut delete = snapshot(document, None, "");
    delete.content = PushContent::Delete;
    assert!(matches!(
        delete.send(&vault.database, &vault.vault).await,
        Err(SyncServerError::ClientError(_))
    ));
    assert_eq!(
        vault
            .database
            .get_latest_document(&vault.vault, &document, None)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn transport_diffs_reconstruct_exact_snapshots_and_reject_invalid_bases() {
    let vault = TestVault::new().await;
    let document = uuid::Uuid::new_v4();
    let original = "Hello world 🌍";
    let desired = "Hi beautiful world 🌍";
    let base = accepted(vault.send(snapshot(document, None, original)).await);
    let mut update = snapshot(document, Some(base.vault_update_id), "");
    update.content =
        PushContent::Diff(EditedText::from_strings(original, &desired.into()).to_diff());
    let updated = accepted(vault.send(update).await);
    assert_eq!(vault.latest(document).await.content, desired.as_bytes());

    for invalid_length in [i64::MIN, i64::MAX] {
        let mut malformed = snapshot(document, Some(updated.vault_update_id), "");
        malformed.content = PushContent::Diff(vec![NumberOrText::Number(invalid_length)]);
        assert!(matches!(
            malformed.send(&vault.database, &vault.vault).await,
            Err(SyncServerError::ClientError(_))
        ));
    }
    assert_eq!(
        vault.latest(document).await.vault_update_id,
        updated.vault_update_id
    );

    let another = accepted(
        vault
            .send(snapshot(uuid::Uuid::new_v4(), None, "another document"))
            .await,
    );
    let mut foreign_base = snapshot(document, Some(another.vault_update_id), "");
    foreign_base.content = PushContent::Diff(vec![]);
    assert!(
        matches!(vault.send(foreign_base).await, DocumentUpdateResponse::StaleBase(version) if version.vault_update_id == updated.vault_update_id)
    );

    let binary_document = uuid::Uuid::new_v4();
    let mut binary = snapshot(binary_document, None, "");
    binary.content = PushContent::Snapshot(STANDARD.encode([0xff]));
    let binary_base = accepted(vault.send(binary).await);
    let mut invalid_text = snapshot(binary_document, Some(binary_base.vault_update_id), "");
    invalid_text.content = PushContent::Diff(vec![]);
    assert!(matches!(
        invalid_text.send(&vault.database, &vault.vault).await,
        Err(SyncServerError::ClientError(_))
    ));
    assert_eq!(
        vault.latest(binary_document).await.vault_update_id,
        binary_base.vault_update_id
    );
}

#[tokio::test]
async fn renames_allocate_paths_atomically_without_rewriting_history() {
    let vault = TestVault::new().await;
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let base = accepted(vault.send(snapshot(first, None, "first")).await);
    let collision = accepted(vault.send(snapshot(second, None, "second")).await);
    assert_ne!(base.relative_path, collision.relative_path);

    let mut rename = snapshot(first, Some(base.vault_update_id), "first");
    rename.relative_path = "renamed.md".to_owned();
    let renamed = accepted(vault.send(rename).await);
    let mut stale_rename = snapshot(first, Some(base.vault_update_id), "first");
    stale_rename.relative_path = "stale.md".to_owned();
    assert!(
        matches!(vault.send(stale_rename).await, DocumentUpdateResponse::StaleBase(version) if version.relative_path == renamed.relative_path)
    );

    let mut move_into_occupied = snapshot(second, Some(collision.vault_update_id), "second");
    move_into_occupied.relative_path = renamed.relative_path.clone();
    let allocated = accepted(vault.send(move_into_occupied).await);
    assert_ne!(allocated.relative_path, renamed.relative_path);
    assert_eq!(vault.latest(first).await.relative_path, "renamed.md");
    assert_eq!(
        vault
            .database
            .get_document_version(&vault.vault, base.vault_update_id, None)
            .await
            .unwrap()
            .unwrap()
            .relative_path,
        "note.md"
    );
}
