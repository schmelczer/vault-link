use anyhow::{Result, ensure};

use crate::consts::MAX_RELATIVE_PATH_LEN;

/// Sanitize the document's path to allow all clients to create the same path in
/// their filesystem. If we didn't do this server-side, client's would need to
/// deal with mapping invalid names to valid ones and then back.
pub fn sanitize_path(path: &str) -> Result<String> {
    // Enforce the length cap at the single chokepoint every create/update
    // handler goes through, so clients can't blow up axum's JSON/multipart
    // parser with a 1 MB `relative_path` before the handler ever runs.
    // The WebSocket cursor handler enforces this separately.
    ensure!(
        path.len() <= MAX_RELATIVE_PATH_LEN,
        "Relative path exceeds the maximum length of {MAX_RELATIVE_PATH_LEN} bytes"
    );

    let options = sanitize_filename::Options {
        truncate: true,
        windows: true, // Windows is the lowest common denominator
        replacement: "",
    };

    let result = path
        .split('/')
        .map(|part| {
            let proposal = sanitize_filename::sanitize_with_options(part, options.clone());
            if !part.is_empty() && proposal.is_empty() {
                "_".to_owned()
            } else {
                proposal
            }
        })
        .collect::<Vec<_>>()
        .join("/");

    ensure!(!result.is_empty(), "Relative path is empty after sanitization");
    Ok(result)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_sanitize_path() {
        assert_eq!(sanitize_path("/my/path/what?").unwrap(), "/my/path/what");
        assert_eq!(sanitize_path("file (1).md").unwrap(), "file (1).md");
        assert_eq!(sanitize_path("/my/path/\\\\:?").unwrap(), "/my/path/_");
    }

    #[test]
    fn test_sanitize_path_empty() {
        assert!(sanitize_path("").is_err());
    }

    #[test]
    fn test_sanitize_path_idempotent_simple() {
        let mut result = sanitize_path("notes/my file.md").unwrap();
        for _ in 0..5 {
            result = sanitize_path(&result).unwrap();
        }
        assert_eq!(result, "notes/my file.md");
    }

    #[test]
    fn test_sanitize_path_idempotent_special_chars() {
        let first = sanitize_path("/my/path/what?/file:name<>.md").unwrap();
        let mut result = first.clone();
        for _ in 0..5 {
            result = sanitize_path(&result).unwrap();
        }
        assert_eq!(result, first);
    }
}
