use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("repository {0} is not open")]
    UnknownRepo(u32),
    #[error("{0}")]
    Git(String),
    #[error("{0}")]
    Profile(String),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn git(e: impl std::fmt::Display) -> Self {
        Self::Git(e.to_string())
    }

    pub fn profile(e: impl std::fmt::Display) -> Self {
        Self::Profile(e.to_string())
    }
}

// Tauri requires command errors to be `Serialize`; send the display string only,
// never debug output that could leak local paths or internals.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
