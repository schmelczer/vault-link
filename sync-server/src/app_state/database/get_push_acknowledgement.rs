use anyhow::{Context as _, Result};

use super::models::{StoredDocumentVersion, VaultId};
use super::{Database, Transaction};

impl Database {
    /// Look up the immutable version acknowledged by a previous push.
    pub async fn get_push_acknowledgement(
        &self,
        vault_id: &VaultId,
        request_id: uuid::Uuid,
        transaction: &mut Transaction<'_>,
    ) -> Result<Option<(Vec<u8>, StoredDocumentVersion)>> {
        let request_id = request_id.hyphenated().to_string();
        let acknowledgement = sqlx::query!(
            "select vault_update_id, request_fingerprint from push_acknowledgements where request_id = ?",
            request_id
        )
        .fetch_optional(&mut **transaction)
        .await
        .context("Cannot fetch push acknowledgement")?;

        match acknowledgement {
            Some(acknowledgement) => {
                let version = self
                    .get_document_version(
                        vault_id,
                        acknowledgement.vault_update_id,
                        Some(transaction),
                    )
                    .await?
                    .context("Acknowledged document version is missing")?;
                Ok(Some((acknowledgement.request_fingerprint, version)))
            }
            None => Ok(None),
        }
    }
}
