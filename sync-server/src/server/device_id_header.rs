use axum_extra::headers;
use headers::{Header, HeaderName, HeaderValue};

pub struct DeviceIdHeader(pub String);

pub static DEVICE_ID_HEADER_NAME: HeaderName = HeaderName::from_static("device-id");

impl Header for DeviceIdHeader {
    fn name() -> &'static HeaderName {
        &DEVICE_ID_HEADER_NAME
    }

    fn decode<'i, I>(values: &mut I) -> Result<Self, headers::Error>
    where
        I: Iterator<Item = &'i HeaderValue>,
    {
        let value = values.next().ok_or_else(headers::Error::invalid)?;

        let s = value.to_str().map_err(|_| headers::Error::invalid())?;

        if s.is_empty() || s.len() > 256 {
            return Err(headers::Error::invalid());
        }

        // Only allow safe characters to prevent log injection and similar attacks.
        // Covers UUIDs, user-agent strings like "vault-link/1.0 (12345; linux)",
        // and human-readable device names.
        if !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./ ();:@+,".contains(c))
        {
            return Err(headers::Error::invalid());
        }

        Ok(DeviceIdHeader(s.to_owned()))
    }

    fn encode<E>(&self, values: &mut E)
    where
        E: Extend<HeaderValue>,
    {
        if let Ok(value) = HeaderValue::from_str(&self.0) {
            values.extend(std::iter::once(value));
        }
    }
}
