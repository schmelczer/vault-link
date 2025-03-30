use reconcile::{CursorPosition, TextWithCursors};
use wasm_bindgen::prelude::*;

/// Wrapper type to expose `TextWithCursors` to JS.
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq)]
pub struct OwnedTextWithCursors {
    text: String,
    cursors: Vec<OwnedCursorPosition>,
}

impl OwnedTextWithCursors {
    pub fn new(text: impl Into<String>, cursors: Vec<OwnedCursorPosition>) -> Self {
        Self {
            text: text.into(),
            cursors,
        }
    }
}

impl From<OwnedTextWithCursors> for TextWithCursors<'_> {
    fn from(owned: OwnedTextWithCursors) -> Self {
        TextWithCursors::new_owned(
            owned.text.to_string(),
            owned
                .cursors
                .into_iter()
                .map(|cursor| cursor.into())
                .collect(),
        )
    }
}

impl From<TextWithCursors<'_>> for OwnedTextWithCursors {
    fn from(text_with_cursors: TextWithCursors<'_>) -> Self {
        OwnedTextWithCursors {
            text: text_with_cursors.text.into_owned(),
            cursors: text_with_cursors
                .cursors
                .into_iter()
                .map(|cursor| cursor.into())
                .collect(),
        }
    }
}

/// Wrapper type to expose `CursorPosition` to JS.
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq)]
pub struct OwnedCursorPosition {
    pub id: usize,
    pub char_index: usize,
}

impl From<OwnedCursorPosition> for CursorPosition {
    fn from(owned: OwnedCursorPosition) -> Self {
        CursorPosition {
            id: owned.id,
            char_index: owned.char_index,
        }
    }
}

impl From<CursorPosition> for OwnedCursorPosition {
    fn from(cursor: CursorPosition) -> Self {
        OwnedCursorPosition {
            id: cursor.id,
            char_index: cursor.char_index,
        }
    }
}
