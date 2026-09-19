use anyhow::{Result, ensure};
use serde::{Deserialize, Deserializer, de::Error};

pub fn normalize_vault_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    let vault = normalize_string(&s);
    validate_vault_id(&vault).map_err(D::Error::custom)?;
    Ok(vault)
}

pub fn normalize_string(s: &str) -> String {
    s.trim().to_lowercase()
}

pub fn validate_vault_id(vault: &str) -> Result<()> {
    ensure!(
        !vault.is_empty()
            && vault != "."
            && vault != ".."
            && !vault
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\')),
        "Vault names must be nonempty names without path separators, traversal components, or control characters"
    );
    Ok(())
}
