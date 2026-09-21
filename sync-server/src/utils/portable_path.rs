use crate::app_state::database::models::FileManifestEntries;
use anyhow::{Result, bail, ensure};
use std::collections::BTreeMap;
use unicode_normalization::UnicodeNormalization;

pub const INTERNAL_DIRECTORY: &str = ".vault-link-sync";

// Use the same locale-independent Unicode upper-case mapping in the client.
// NFC -> uppercase -> NFC also catches ß/SS and final/ordinary sigma aliases.
pub fn path_key(path: &str) -> String {
    path.nfc()
        .collect::<String>()
        .to_uppercase()
        .nfc()
        .collect()
}

pub fn validate_file_manifest(entries: &FileManifestEntries) -> Result<()> {
    // Store one component per node. Expanding every prefix makes a short,
    // deeply nested path consume quadratic memory and CPU before any I/O.
    let mut nodes: BTreeMap<(usize, String), (usize, &str, bool)> = BTreeMap::new();

    for path in entries.values() {
        ensure!(!path.is_empty(), "Path must not be empty");

        ensure!(
            path.nfc().collect::<String>() == *path,
            "Paths must be NFC normalized"
        );

        let parts: Vec<_> = path.split('/').collect();

        ensure!(
            path_key(parts[0]) != path_key(INTERNAL_DIRECTORY),
            "Reserved sync directory"
        );

        let mut parent = 0;
        for (index, part) in parts.iter().enumerate() {
            ensure!(
                !part.is_empty() && *part != "." && *part != "..",
                "Invalid path component"
            );

            ensure!(!part.ends_with(['.', ' ']), "Trailing dot or space in path");

            ensure!(
                !part
                    .chars()
                    .any(|c| c.is_control() || c == '\\' || "<>:\"|?*".contains(c)),
                "Non-portable filename"
            );

            let stem = part
                .split('.')
                .next()
                .unwrap_or_default()
                .trim_end_matches(' ')
                .to_uppercase();

            ensure!(
                !matches!(
                    stem.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                ),
                "Reserved filename"
            );

            if stem.starts_with("COM") || stem.starts_with("LPT") {
                ensure!(
                    !matches!(
                        &stem[3..],
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    ),
                    "Reserved filename"
                );
            }

            let is_file = index == parts.len() - 1;
            let key = (parent, path_key(part));

            if let Some((node, spelling, previous_is_file)) = nodes.get(&key) {
                if spelling != part || *previous_is_file || is_file {
                    bail!("Conflicting path: {path}");
                }
                parent = *node;
            } else {
                let node = nodes.len() + 1;
                nodes.insert(key, (node, part, is_file));
                parent = node;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{FileManifestEntries, path_key, validate_file_manifest};
    use uuid::Uuid;

    fn manifest(paths: &[&str]) -> FileManifestEntries {
        paths
            .iter()
            .enumerate()
            .map(|(index, path)| (Uuid::from_u128(index as u128), (*path).to_owned()))
            .collect()
    }

    #[test]
    fn path_keys_normalize_unicode_and_case_aliases() {
        for (path, expected) in [
            ("Notes/Café.md", "NOTES/CAFÉ.MD"),
            ("notes/Cafe\u{301}.md", "NOTES/CAFÉ.MD"),
            ("Straße.md", "STRASSE.MD"),
            ("σς.md", "ΣΣ.MD"),
        ] {
            assert_eq!(path_key(path), expected, "path: {path:?}");
        }
    }

    #[test]
    fn accepts_empty_manifests_and_portable_paths_with_shared_directories() {
        validate_file_manifest(&manifest(&[])).unwrap();

        let entries = manifest(&[
            "Notes/Café.md",
            "Notes/日記.md",
            "Notes/Archive/old.md",
            ".gitkeep",
            "COM10.txt",
            "LPT0.txt",
            ".vault-link-sync-backup/state.json",
            "Notes/.vault-link-sync/state.json",
        ]);

        validate_file_manifest(&entries).unwrap();
    }

    #[test]
    fn does_not_impose_a_cross_platform_total_path_limit() {
        for path in ["a".repeat(300), "é".repeat(200)] {
            validate_file_manifest(&manifest(&[&path])).unwrap();
        }
    }

    #[test]
    fn deep_paths_do_not_expand_every_prefix() {
        let path = vec!["a"; 10_000].join("/");
        let started = std::time::Instant::now();
        validate_file_manifest(&manifest(&[&path])).unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "A 20 KB path exhausted the validation work budget: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn rejects_invalid_components_characters_and_non_normalized_paths() {
        for path in [
            "",
            "/notes.md",
            "notes.md/",
            "notes//a.md",
            "./notes.md",
            "notes/../a.md",
            "notes./a.md",
            "notes /a.md",
            "Cafe\u{301}.md",
        ] {
            assert!(
                validate_file_manifest(&manifest(&[path])).is_err(),
                "accepted invalid path: {path:?}"
            );
        }

        for character in ['\\', '<', '>', ':', '"', '|', '?', '*', '\0', '\u{85}'] {
            let path = format!("notes/a{character}b.md");

            assert!(
                validate_file_manifest(&manifest(&[&path])).is_err(),
                "accepted non-portable character in path: {path:?}"
            );
        }
    }

    #[test]
    fn rejects_reserved_sync_and_windows_names() {
        for path in [
            ".vault-link-sync",
            ".VAULT-LINK-SYNC/state.json",
            "con",
            "prn.txt",
            "AUX.md",
            "nul .txt",
            "CONIN$",
            "conout$.log",
            "com1.txt",
            "LPT9",
            "COM¹.txt",
            "lpt²/file.md",
            "COM³.txt",
        ] {
            assert!(
                validate_file_manifest(&manifest(&[path])).is_err(),
                "accepted reserved path: {path:?}"
            );
        }
    }

    #[test]
    fn rejects_path_conflicts_in_either_entry_order() {
        for [first, second] in [
            ["notes.md", "notes.md"],
            ["Notes.md", "notes.md"],
            ["Straße.md", "STRASSE.md"],
            ["ς.md", "σ.md"],
            ["Notes/a.md", "notes/b.md"],
            ["notes", "notes/a.md"],
        ] {
            for paths in [[first, second], [second, first]] {
                assert!(
                    validate_file_manifest(&manifest(&paths)).is_err(),
                    "accepted conflicting paths: {paths:?}"
                );
            }
        }
    }
}
