pub fn is_file_type_mergable(path_or_file_name: &str, mergeable_extensions: &[String]) -> bool {
    let file_extension = path_or_file_name.split('.').next_back().unwrap_or_default();
    let file_extension_lower = file_extension.to_lowercase();

    mergeable_extensions
        .iter()
        .any(|ext| ext.to_lowercase() == file_extension_lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_file_type_mergable() {
        let mergeable = vec!["md".to_owned(), "txt".to_owned()];

        assert!(is_file_type_mergable(".md", &mergeable));
        assert!(is_file_type_mergable("hi.md", &mergeable));
        assert!(is_file_type_mergable(
            "my/path/to/my/document.md",
            &mergeable
        ));
        assert!(is_file_type_mergable("hi.MD", &mergeable));
        assert!(is_file_type_mergable(
            "my/path/to/my/DOCUMENT.MD",
            &mergeable
        ));

        assert!(!is_file_type_mergable(".json", &mergeable));
        assert!(!is_file_type_mergable("HELLO.JSON", &mergeable));
        assert!(!is_file_type_mergable("my/config.yml", &mergeable));
    }
}
