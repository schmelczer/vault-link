use std::borrow::Cow;

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

// CursorPosition is a wrapper around usize to represent the position of an
// identifiable cursor in a text document based on the character index.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CursorPosition {
    pub id: usize,
    pub char_index: usize,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TextWithCursors<'a> {
    pub text: Cow<'a, str>,
    pub cursors: Vec<CursorPosition>,
}

impl<'a> TextWithCursors<'a> {
    pub fn new(text: &'a str, cursors: Vec<CursorPosition>) -> Self {
        Self {
            text: text.into(),
            cursors,
        }
    }

    pub fn new_owned(text: String, cursors: Vec<CursorPosition>) -> Self {
        Self {
            text: text.into(),
            cursors,
        }
    }
}

impl<'a> From<&'a str> for TextWithCursors<'a> {
    fn from(text: &'a str) -> Self {
        Self {
            text: text.into(),
            cursors: Vec::new(),
        }
    }
}
