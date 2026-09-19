use super::{VaultPath, utils::find_already_processed_event};
use crate::{
    app_state::{
        AppState,
        database::{
            Database,
            models::{DocumentId, EventRecord, StoredDocumentVersion, VaultEvent, VaultId},
        },
    },
    config::user_config::User,
    errors::{SyncServerError, client_error, not_found_error, server_error},
    server::{
        device_id_header::DeviceIdHeader,
        requests::{PushContent, PutFileContent},
        responses::DocumentUpdateResponse,
    },
};
use anyhow::anyhow;
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use axum_extra::TypedHeader;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use log::debug;
use reconcile_text::{BuiltinTokenizer, EditedText, NumberOrText};
use sha2::{Digest, Sha256};

#[axum::debug_handler]
pub async fn put_file_content(
    Path((VaultPath(vault_id), document_id)): Path<(VaultPath, DocumentId)>,
    Extension(user): Extension<User>,
    TypedHeader(device): TypedHeader<DeviceIdHeader>,
    State(state): State<AppState>,
    Json(push): Json<PutFileContent>,
) -> Result<Json<DocumentUpdateResponse>, SyncServerError> {
    debug!("Pushing document `{}` in vault `{}`", document_id, vault_id);

    let fingerprint = Sha256::digest(
        serde_json::to_vec(&("content", document_id, &push))
            .map_err(|error| server_error(error.into()))?,
    );

    let mut tx = state
        .database
        .create_write_transaction(&vault_id)
        .await
        .map_err(server_error)?;

    if let Some(event) =
        find_already_processed_event(&mut tx, push.request_id, &fingerprint).await?
    {
        return match event {
            VaultEvent::Content { document } => {
                Ok(Json(DocumentUpdateResponse::Accepted(document)))
            }
            VaultEvent::FileManifest { .. } => Err(server_error(anyhow!(
                "Stored event does not match content request"
            ))),
        };
    }

    let parent = state
        .database
        .get_latest_document_version(&vault_id, &document_id, Some(&mut tx))
        .await
        .map_err(server_error)?;

    if let Some(parent) = &parent {
        if Some(parent.vault_update_id) != push.parent_version_id {
            return Ok(Json(DocumentUpdateResponse::StaleBase(
                parent.clone().into(),
            )));
        }
    } else if push.parent_version_id.is_some() {
        return Err(not_found_error(anyhow!(
            "Document {} does not exist",
            document_id
        )));
    }

    let content = match push.content {
        PushContent::Snapshot(bytes) => STANDARD
            .decode(bytes)
            .map_err(|error| client_error(error.into()))?,

        PushContent::Diff(diff) => {
            if diff
                .iter()
                .any(|n| matches!(n, NumberOrText::Number(i64::MIN)))
            {
                return Err(client_error(anyhow!("Invalid diff length")));
            }

            let parent = parent
                .as_ref()
                .ok_or_else(|| client_error(anyhow!("Diff requires a parent")))?;

            let text =
                str::from_utf8(&parent.content).map_err(|error| client_error(error.into()))?;

            EditedText::from_diff(text, diff, &*BuiltinTokenizer::Word)
                .map_err(|error| client_error(error.into()))?
                .apply()
                .text()
                .into_bytes()
        }
    };

    let version = StoredDocumentVersion {
        vault_update_id: Database::allocate_event(&mut tx, push.request_id, &fingerprint)
            .await
            .map_err(server_error)?,
        document_id,
        content,
        updated_date: chrono::Utc::now(),
        user_id: user.name,
        device_id: device.0,
    };

    Database::insert_document_version(&mut tx, &version)
        .await
        .map_err(server_error)?;

    let response = DocumentUpdateResponse::Accepted((&version).into());

    let event = EventRecord {
        event_id: version.vault_update_id,
        request_id: push.request_id,
        event: VaultEvent::Content {
            document: version.into(),
        },
    };

    Database::write_event(&mut tx, &event)
        .await
        .map_err(server_error)?;

    tx.commit()
        .await
        .map_err(|error| server_error(error.into()))?;

    state.broadcasts.notify_about_vault_update(vault_id).await;

    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::{
        app_state::database::{
            Database,
            models::{DocumentVersionWithoutContent, StoredDocumentVersion, VaultUpdateId},
        },
        config::{
            Config, database_config::DatabaseConfig, server_config::ServerConfig,
            user_config::VaultAccess,
        },
    };

    async fn send_document(
        state: &AppState,
        vault: &VaultId,
        document_id: DocumentId,
        user_id: String,
        device_id: String,
        push: PutFileContent,
    ) -> Result<DocumentUpdateResponse, SyncServerError> {
        put_file_content(
            Path((VaultPath(vault.clone()), document_id)),
            Extension(User {
                name: user_id,
                token: String::new(),
                vault_access: VaultAccess::default(),
            }),
            TypedHeader(DeviceIdHeader(device_id)),
            State(state.clone()),
            Json(push),
        )
        .await
        .map(|Json(response)| response)
    }

    struct Push {
        document_id: DocumentId,
        request_id: uuid::Uuid,
        parent_version_id: Option<VaultUpdateId>,
        content: PushContent,
        user_id: String,
        device_id: String,
    }

    impl Push {
        async fn send(
            self,
            state: &AppState,
            vault: &VaultId,
        ) -> Result<DocumentUpdateResponse, SyncServerError> {
            send_document(
                state,
                vault,
                self.document_id,
                self.user_id,
                self.device_id,
                PutFileContent {
                    request_id: self.request_id,
                    parent_version_id: self.parent_version_id,
                    content: self.content,
                },
            )
            .await
        }
    }

    struct TestVault {
        directory: PathBuf,
        state: AppState,
        vault: VaultId,
    }

    impl TestVault {
        async fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("vaultlink-cas-{}", uuid::Uuid::new_v4()));
            let state = Self::open(&directory).await;
            Self {
                directory,
                state,
                vault: "test".to_owned(),
            }
        }

        async fn open(directory: &std::path::Path) -> AppState {
            AppState::try_new(Config {
                database: DatabaseConfig {
                    databases_directory_path: directory.to_owned(),
                    ..Default::default()
                },
                server: ServerConfig {
                    max_clients_per_vault: 16,
                    ..Default::default()
                },
                ..Default::default()
            })
            .await
            .unwrap()
        }

        async fn send(&self, push: Push) -> DocumentUpdateResponse {
            push.send(&self.state, &self.vault).await.unwrap()
        }

        async fn latest(&self, document: DocumentId) -> StoredDocumentVersion {
            self.state
                .database
                .get_latest_document_version(&self.vault, &document, None)
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
        let request: PutFileContent = serde_json::from_value(serde_json::json!({
            "requestId": uuid::Uuid::new_v4(),
            "parentVersionId": null,
            "content": { "type": "Snapshot", "value": STANDARD.encode(content) },
        }))
        .unwrap();
        let base = accepted(
            send_document(
                &vault.state,
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
        let mut tx = vault
            .state
            .database
            .create_readonly_transaction(&vault.vault)
            .await
            .unwrap();
        let stored_document_id: String =
            sqlx::query_scalar("SELECT document_id FROM documents WHERE vault_update_id = ?")
                .bind(base.vault_update_id)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(stored_document_id, document.to_string());
        tx.commit().await.unwrap();
        assert!(serde_json::to_value(&base).unwrap().get("mtime").is_none());

        let invalid: PutFileContent = serde_json::from_value(serde_json::json!({
            "requestId": uuid::Uuid::new_v4(),
            "parentVersionId": base.vault_update_id,
            "content": { "type": "Snapshot", "value": "not base64!" },
        }))
        .unwrap();
        assert!(matches!(
            send_document(
                &vault.state,
                &vault.vault,
                document,
                "user".to_owned(),
                "device".to_owned(),
                invalid,
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
            (
                DocumentUpdateResponse::Accepted(winner),
                DocumentUpdateResponse::StaleBase(rejected),
            )
            | (
                DocumentUpdateResponse::StaleBase(rejected),
                DocumentUpdateResponse::Accepted(winner),
            ) => (winner, rejected),
            outcomes => panic!("Expected one accepted push and one stale base: {outcomes:?}"),
        };
        let latest = vault.latest(document).await;
        assert_eq!(winner.vault_update_id, rejected.metadata.vault_update_id);
        assert_eq!(
            STANDARD.decode(rejected.content_base64).unwrap(),
            latest.content
        );
        assert!(latest.content == b"left" || latest.content == b"right");
        let original = vault
            .state
            .database
            .get_document_version(&vault.vault, base.vault_update_id, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(original.content, b"base");
        let mut transaction = vault
            .state
            .database
            .create_readonly_transaction(&vault.vault)
            .await
            .unwrap();
        assert_eq!(
            Database::latest_event_id(&mut transaction).await.unwrap(),
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

        let mut changed_operation = snapshot(document, None, "created");
        changed_operation.content = PushContent::Diff(vec![]);
        for mut changed_payload in [
            snapshot(document, None, "different content"),
            snapshot(document, Some(1), "created"),
            changed_operation,
        ] {
            changed_payload.request_id = create_id;
            assert!(matches!(
                changed_payload.send(&reopened, &vault.vault).await,
                Err(SyncServerError::ClientError(_))
            ));
        }
        let events = reopened
            .database
            .events_after(&vault.vault, 0)
            .await
            .unwrap();
        assert_eq!(events.head_event_id, latest.vault_update_id);
        assert_eq!(events.events.len(), 3);
        assert_eq!(events.events[0].request_id, create_id);
        assert_eq!(events.events[1].request_id, update_id);
    }

    #[tokio::test]
    async fn concurrent_retries_return_the_same_acknowledgement_and_append_one_event() {
        let vault = TestVault::new().await;
        let document = uuid::Uuid::new_v4();
        let original = snapshot(document, None, "created");
        let request_id = original.request_id;
        let mut retry = snapshot(document, None, "created");
        retry.request_id = request_id;
        retry.device_id = "reconnected-device".to_owned();

        let (left, right) = tokio::join!(vault.send(original), vault.send(retry));
        assert_eq!(
            serde_json::to_value(accepted(left)).unwrap(),
            serde_json::to_value(accepted(right)).unwrap()
        );
        let events = vault
            .state
            .database
            .events_after(&vault.vault, 0)
            .await
            .unwrap();
        assert_eq!(events.head_event_id, 1);
        assert_eq!(events.events.len(), 1);
        assert_eq!(events.events[0].request_id, request_id);
    }

    #[tokio::test]
    async fn failed_event_commit_rolls_back_content_and_allows_retrying_the_request() {
        let vault = TestVault::new().await;
        let mut tx = vault
            .state
            .database
            .create_write_transaction(&vault.vault)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER reject_event BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'simulated event write failure'); END")
            .execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();

        let document = uuid::Uuid::new_v4();
        let request = snapshot(document, None, "created");
        let request_id = request.request_id;
        assert!(request.send(&vault.state, &vault.vault).await.is_err());
        assert!(
            vault
                .state
                .database
                .get_latest_document_version(&vault.vault, &document, None)
                .await
                .unwrap()
                .is_none()
        );
        let events = vault
            .state
            .database
            .events_after(&vault.vault, 0)
            .await
            .unwrap();
        assert_eq!(events.head_event_id, 0);
        assert!(events.events.is_empty());

        let mut tx = vault
            .state
            .database
            .create_write_transaction(&vault.vault)
            .await
            .unwrap();
        sqlx::query("DROP TRIGGER reject_event")
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut retry = snapshot(document, None, "created");
        retry.request_id = request_id;
        let version = accepted(vault.send(retry).await);
        assert_eq!(version.vault_update_id, 1);
        let events = vault
            .state
            .database
            .events_after(&vault.vault, 0)
            .await
            .unwrap();
        assert_eq!(events.events.len(), 1);
        assert_eq!(events.events[0].request_id, request_id);
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
                malformed.send(&vault.state, &vault.vault).await,
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
        assert!(matches!(
            vault.send(foreign_base).await,
            DocumentUpdateResponse::StaleBase(version)
                if version.metadata.vault_update_id == updated.vault_update_id
        ));

        let binary_document = uuid::Uuid::new_v4();
        let mut binary = snapshot(binary_document, None, "");
        binary.content = PushContent::Snapshot(STANDARD.encode([0xff]));
        let binary_base = accepted(vault.send(binary).await);
        let mut invalid_text = snapshot(binary_document, Some(binary_base.vault_update_id), "");
        invalid_text.content = PushContent::Diff(vec![]);
        assert!(matches!(
            invalid_text.send(&vault.state, &vault.vault).await,
            Err(SyncServerError::ClientError(_))
        ));
        assert_eq!(
            vault.latest(binary_document).await.vault_update_id,
            binary_base.vault_update_id
        );
    }
}
