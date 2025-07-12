pub fn is_file_type_mergable(path_or_file_name: &str) -> bool {
    let file_extension = path_or_file_name.split('.').next_back().unwrap_or_default();

    matches!(file_extension.to_lowercase().as_str(), "md" | "txt")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_file_type_mergable() {
        assert!(is_file_type_mergable(".md"));
        assert!(is_file_type_mergable("hi.md"));
        assert!(is_file_type_mergable("my/path/to/my/document.md"));
        assert!(is_file_type_mergable("hi.MD"));
        assert!(is_file_type_mergable("my/path/to/my/DOCUMENT.MD"));

        assert!(!is_file_type_mergable(".json"));
        assert!(!is_file_type_mergable("HELLO.JSON"));
        assert!(!is_file_type_mergable("my/config.yml"));
    }
}
