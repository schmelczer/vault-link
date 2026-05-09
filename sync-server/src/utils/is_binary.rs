/// Return the given data as UTF-8 text if it is not considered binary.
///
/// Only text inputs can be reconciled using the crate's functions.
#[must_use]
pub fn as_non_binary_text(data: &[u8]) -> Option<&str> {
    if data.contains(&0) {
        // Even though the NUL character is valid in UTF-8, it's highly suspicious in
        // human-readable text.
        return None;
    }

    std::str::from_utf8(data).ok()
}

/// Heuristically determine if the given data is a binary or a text file's
/// content.
#[must_use]
pub fn is_binary(data: &[u8]) -> bool {
    as_non_binary_text(data).is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_binary() {
        assert!(is_binary(&[0, 159, 146, 150]));
        assert!(is_binary(&[0, 12]));
        assert!(!is_binary(b"hello"));
    }

    #[test]
    fn test_as_non_binary_text() {
        assert_eq!(as_non_binary_text(b"hello"), Some("hello"));
        assert_eq!(as_non_binary_text(&[0, 12]), None);
        assert_eq!(as_non_binary_text(&[0xff]), None);
    }
}
