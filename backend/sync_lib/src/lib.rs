//! This crate provides utilities for easily communicating between backend &
//! frontend and ensuring the same logic for encoding and decoding binary data,
//! and filtering files.
//!
//! The crate is designed to be used as a Rust library and as a
//! TypeScript/JavaScript package through WebAssembly (WASM).
//!
//! # Modules
//!
//! - `errors`: Contains error types used in this crate.

use core::str;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use errors::SyncLibError;
use wasm_bindgen::prelude::*;

pub mod errors;

/// Encode binary data for easy transport over HTTP. Inverse of
/// `base64_to_bytes`.
///
/// # Arguments
///
/// - `input`: The binary data to encode.
///
/// # Returns
///
/// The base64-encoded string.
///
/// # Panics
///
/// If the input is not valid UTF-8.
#[wasm_bindgen(js_name = bytesToBase64)]
#[must_use]
pub fn bytes_to_base64(input: &[u8]) -> String {
    set_panic_hook();

    STANDARD.encode(input)
}

/// Inverse of `bytes_to_base64`.
/// Decode base64-encoded data into binary data.
///
/// # Arguments
///
/// - `input`: The base64-encoded string.
///
/// # Returns
///
/// The decoded binary data.
///
/// # Errors
///
/// If the input is not valid base64.
#[wasm_bindgen(js_name = base64ToBytes)]
pub fn base64_to_bytes(input: &str) -> Result<Vec<u8>, SyncLibError> {
    set_panic_hook();

    STANDARD.decode(input).map_err(SyncLibError::from)
}

/// We don't want to support merging structured data like JSON, YAML, etc.
#[wasm_bindgen(js_name = isFileTypeMergable)]
#[must_use]
pub fn is_file_type_mergable(path_or_file_name: &str) -> bool {
    set_panic_hook();

    let file_extension = path_or_file_name.split('.').next_back().unwrap_or_default();

    matches!(file_extension.to_lowercase().as_str(), "md" | "txt")
}

fn set_panic_hook() {
    // https://github.com/rustwasm/console_error_panic_hook#readme
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}
