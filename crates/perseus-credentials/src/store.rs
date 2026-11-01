use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::validate;

const SERVICE: &str = "perseus";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credential {
    pub username: String,
    pub token: String,
}

// Never print the token, even by accident in a log or panic message.
impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("username", &self.username)
            .field("token", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// A value failed validation and was not stored or looked up.
    Invalid(&'static str),
    /// The OS credential store reported a problem (locked, unavailable, ...).
    Backend(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Invalid(what) => write!(f, "invalid {what}"),
            StoreError::Backend(msg) => write!(f, "credential store error: {msg}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// Tokens keyed by `(profile id, host)`.
pub trait SecretStore {
    fn get(&self, profile: &str, host: &str) -> Result<Option<Credential>, StoreError>;
    fn set(&self, profile: &str, host: &str, cred: &Credential) -> Result<(), StoreError>;
    /// Removing something that does not exist is not an error.
    fn delete(&self, profile: &str, host: &str) -> Result<(), StoreError>;
}

/// Validates the lookup key and returns the normalised host.
fn key(profile: &str, host: &str) -> Result<(String, String), StoreError> {
    if !validate::is_profile_id(profile) {
        return Err(StoreError::Invalid("profile id"));
    }
    let host = validate::host(host).ok_or(StoreError::Invalid("host"))?;
    Ok((format!("{profile}@{host}"), host))
}

fn check(cred: &Credential) -> Result<(), StoreError> {
    if !validate::is_plain_text(&cred.username) {
        return Err(StoreError::Invalid("username"));
    }
    if !validate::is_plain_text(&cred.token) {
        return Err(StoreError::Invalid("token"));
    }
    Ok(())
}

/// The operating system's keychain.
pub struct KeyringStore;

impl KeyringStore {
    fn entry(user: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(SERVICE, user).map_err(|e| StoreError::Backend(e.to_string()))
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, profile: &str, host: &str) -> Result<Option<Credential>, StoreError> {
        let (user, _) = key(profile, host)?;
        match Self::entry(&user)?.get_password() {
            Ok(json) => {
                let cred: Credential = serde_json::from_str(&json)
                    .map_err(|_| StoreError::Backend("stored credential is corrupt".into()))?;
                Ok(Some(cred))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(StoreError::Backend(e.to_string())),
        }
    }

    fn set(&self, profile: &str, host: &str, cred: &Credential) -> Result<(), StoreError> {
        let (user, _) = key(profile, host)?;
        check(cred)?;
        let json = serde_json::to_string(cred).expect("credential serialises");
        Self::entry(&user)?
            .set_password(&json)
            .map_err(|e| StoreError::Backend(e.to_string()))
    }

    fn delete(&self, profile: &str, host: &str) -> Result<(), StoreError> {
        let (user, _) = key(profile, host)?;
        match Self::entry(&user)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(StoreError::Backend(e.to_string())),
        }
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, Credential>>);

impl SecretStore for MemoryStore {
    fn get(&self, profile: &str, host: &str) -> Result<Option<Credential>, StoreError> {
        let (user, _) = key(profile, host)?;
        Ok(self.0.lock().unwrap().get(&user).cloned())
    }

    fn set(&self, profile: &str, host: &str, cred: &Credential) -> Result<(), StoreError> {
        let (user, _) = key(profile, host)?;
        check(cred)?;
        self.0.lock().unwrap().insert(user, cred.clone());
        Ok(())
    }

    fn delete(&self, profile: &str, host: &str) -> Result<(), StoreError> {
        let (user, _) = key(profile, host)?;
        self.0.lock().unwrap().remove(&user);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "0123456789abcdef0123456789abcdef";

    fn cred(token: &str) -> Credential {
        Credential {
            username: "ada".into(),
            token: token.into(),
        }
    }

    #[test]
    fn memory_store_roundtrip_and_isolation() {
        let s = MemoryStore::default();
        let other = "f".repeat(32);
        s.set(P, "GitHub.com", &cred("t1")).unwrap();

        assert_eq!(s.get(P, "github.com").unwrap(), Some(cred("t1")));
        assert_eq!(s.get(&other, "github.com").unwrap(), None);
        assert_eq!(s.get(P, "gitlab.com").unwrap(), None);

        s.delete(P, "github.com").unwrap();
        s.delete(P, "github.com").unwrap(); // idempotent
        assert_eq!(s.get(P, "github.com").unwrap(), None);
    }

    #[test]
    fn rejects_values_that_could_inject_protocol_lines() {
        let s = MemoryStore::default();
        for token in ["a\nhost=evil.com", "a\rb", "a\0b", ""] {
            assert_eq!(
                s.set(P, "github.com", &cred(token)),
                Err(StoreError::Invalid("token"))
            );
        }
        let bad_user = Credential {
            username: "x\npassword=y".into(),
            token: "t".into(),
        };
        assert_eq!(
            s.set(P, "github.com", &bad_user),
            Err(StoreError::Invalid("username"))
        );
        assert!(s.set("short", "github.com", &cred("t")).is_err());
        assert!(s.set(P, "bad host", &cred("t")).is_err());
    }

    #[test]
    fn debug_output_hides_the_token() {
        let shown = format!("{:?}", cred("super-secret-token"));
        assert!(!shown.contains("super-secret-token"));
        assert!(shown.contains("redacted"));
    }

    /// Talks to the real OS keychain. Run manually: `cargo test -p perseus-credentials -- --ignored`.
    #[test]
    #[ignore]
    fn keyring_store_roundtrip() {
        let profile = format!("{:032x}", std::process::id() as u128 * 7919);
        let s = KeyringStore;
        s.delete(&profile, "test.invalid").unwrap();
        assert_eq!(s.get(&profile, "test.invalid").unwrap(), None);

        s.set(&profile, "test.invalid", &cred("kr-token")).unwrap();
        assert_eq!(
            s.get(&profile, "test.invalid").unwrap(),
            Some(cred("kr-token"))
        );

        s.delete(&profile, "test.invalid").unwrap();
        assert_eq!(s.get(&profile, "test.invalid").unwrap(), None);
    }
}
