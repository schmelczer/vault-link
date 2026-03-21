use super::decode_text::decode_text;

/// Determine if the given data is binary (not valid UTF-8).
///
/// Clients transcode UTF-16 to UTF-8 at the read boundary, so the
/// server only ever receives UTF-8 text or binary content.
#[must_use]
pub fn is_binary(data: &[u8]) -> bool {
    decode_text(data).is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_binary() {
        assert!(is_binary(&[0x80, 0x81, 0x82]));
        assert!(!is_binary(b"hello"));
    }

    #[test]
    fn test_nul_bytes_in_utf8_are_text() {
        assert!(!is_binary(b"hello\x00world"));
        assert!(!is_binary(&[0, 12]));
    }
}
