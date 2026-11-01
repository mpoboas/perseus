//! Credential storage and the git credential-helper protocol for Perseus.
//!
//! Secrets live only in the operating system's keychain (Windows Credential
//! Manager, macOS Keychain, Secret Service on Linux), keyed by profile id and host.
//! The helper binary and the app share this crate so both agree on validation.

pub mod protocol;
mod store;
pub mod validate;

pub use store::{Credential, KeyringStore, MemoryStore, SecretStore, StoreError};
