use anyhow::{Context as _, Result};

use super::models::{StoredDocumentVersion, VaultId};
use super::{Database, Transaction};
use crate::app_state::websocket::models::{
    WebSocketServerMessage, WebSocketServerMessageWithOrigin, WebSocketVaultUpdate,
};

impl Database {
    /// Commit the snapshot and acknowledgement atomically, then notify subscribers.
    pub async fn insert_document_version(
        &self,
        vault_id: &VaultId,
        version: &StoredDocumentVersion,
        request_id: uuid::Uuid,
        request_fingerprint: &[u8],
        mut transaction: Transaction<'_>,
    ) -> Result<()> {
        let document_id = version.document_id.as_hyphenated();
        sqlx::query!(
            r#"
            insert into documents (
                vault_update_id,
                document_id,
                relative_path,
                updated_date,
                content,
                is_deleted,
                user_id,
                device_id
            )
            values (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            version.vault_update_id,
            document_id,
            version.relative_path,
            version.updated_date,
            version.content,
            version.is_deleted,
            version.user_id,
            version.device_id
        )
        .execute(&mut *transaction)
        .await
        .context("Cannot insert document version")?;

        let request_id = request_id.hyphenated().to_string();
        sqlx::query!(
            "insert into push_acknowledgements (request_id, request_fingerprint, vault_update_id) values (?, ?, ?)",
            request_id,
            request_fingerprint,
            version.vault_update_id
        )
        .execute(&mut *transaction)
        .await
        .context("Cannot save push acknowledgement")?;

        transaction
            .commit()
            .await
            .context("Failed to commit push")?;

        // notifying the listeners here means that no update can circumvent this step
        self.broadcasts
            .send_document_update(
                vault_id.clone(),
                WebSocketServerMessageWithOrigin::with_origin(
                    version.device_id.clone(),
                    WebSocketServerMessage::VaultUpdate(WebSocketVaultUpdate {
                        documents: vec![version.clone().into()],
                        is_initial_sync: false,
                    }),
                ),
            )
            .await;

        Ok(())
    }
}
