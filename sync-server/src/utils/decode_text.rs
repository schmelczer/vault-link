/// Decode bytes as UTF-8.
///
/// Returns `None` if the content is not valid UTF-8.
///
/// Clients are expected to transcode UTF-16 content to UTF-8 before
/// sending, so the server only needs to handle UTF-8 text and binary.
pub fn decode_text(data: &[u8]) -> Option<String> {
    std::str::from_utf8(data).ok().map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_utf8() {
        assert_eq!(decode_text(b"hello"), Some("hello".to_owned()));
    }

    #[test]
    fn test_utf8_with_bom() {
        // UTF-8 BOM is valid UTF-8 — the BOM character is preserved in the string
        assert_eq!(
            decode_text(&[0xEF, 0xBB, 0xBF, b'h', b'i']),
            Some("\u{FEFF}hi".to_owned())
        );
    }

    #[test]
    fn test_binary_returns_none() {
        assert_eq!(decode_text(&[0x80, 0x81, 0x82]), None);
    }

    #[test]
    fn test_nul_bytes_are_valid() {
        assert_eq!(
            decode_text(b"hello\x00world"),
            Some("hello\x00world".to_owned())
        );
    }
}
