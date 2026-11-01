use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::validate;

const SERVICE: &str = "perseus";

/// What is needed to renew an OAuth access token without asking the user again.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthState {
    /// Where to POST the refresh request; validated like every endpoint we contact.
    pub token_url: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds. `None` means the access token does not expire (GitHub OAuth apps).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

impl fmt::Debug for OAuthState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuthState")
            .field("token_url", &self.token_url)
            .field("client_id", &self.client_id)
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credential {
    pub username: String,
    pub token: String,
    /// Present for tokens obtained through an OAuth sign-in; absent for pasted tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthState>,
}

impl Credential {
    /// A plain token (personal access token, API token).
    pub fn new(username: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            token: token.into(),
            oauth: None,
        }
    }
}

// Never print a token, even by accident in a log or panic message.
impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("username", &self.username)
            .field("token", &"<redacted>")
            .field("oauth", &self.oauth)
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
    if let Some(o) = &cred.oauth {
        if !validate::endpoint_url(&o.token_url) {
            return Err(StoreError::Invalid("token endpoint"));
        }
        if !validate::is_plain_text(&o.client_id) {
            return Err(StoreError::Invalid("client id"));
        }
        if o.refresh_token
            .as_deref()
            .is_some_and(|r| !validate::is_plain_text(r))
        {
            return Err(StoreError::Invalid("refresh token"));
        }
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
        Credential::new("ada", token)
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
        let bad_user = Credential::new("x\npassword=y", "t");
        assert_eq!(
            s.set(P, "github.com", &bad_user),
            Err(StoreError::Invalid("username"))
        );
        assert!(s.set("short", "github.com", &cred("t")).is_err());
        assert!(s.set(P, "bad host", &cred("t")).is_err());
    }

    #[test]
    fn oauth_state_is_validated() {
        let s = MemoryStore::default();
        let with = |token_url: &str, client_id: &str, refresh: Option<&str>| {
            let mut c = cred("t");
            c.oauth = Some(OAuthState {
                token_url: token_url.into(),
                client_id: client_id.into(),
                refresh_token: refresh.map(str::to_string),
                expires_at: Some(1),
            });
            c
        };
        let url = "https://gitlab.com/oauth/token";
        assert!(s.set(P, "gitlab.com", &with(url, "cid", Some("r"))).is_ok());
        assert_eq!(
            s.set(
                P,
                "gitlab.com",
                &with("http://evil.example/token", "cid", None)
            ),
            Err(StoreError::Invalid("token endpoint"))
        );
        assert_eq!(
            s.set(P, "gitlab.com", &with(url, "c\nid", None)),
            Err(StoreError::Invalid("client id"))
        );
        assert_eq!(
            s.set(P, "gitlab.com", &with(url, "cid", Some("r\nx"))),
            Err(StoreError::Invalid("refresh token"))
        );
    }

    #[test]
    fn old_stored_json_without_oauth_fields_still_loads() {
        let c: Credential = serde_json::from_str(r#"{"username":"ada","token":"t"}"#).unwrap();
        assert_eq!(c, cred("t"));
        // And plain tokens serialise without any oauth key.
        assert!(!serde_json::to_string(&c).unwrap().contains("oauth"));
    }

    #[test]
    fn debug_output_hides_every_secret() {
        let mut c = cred("super-secret-token");
        c.oauth = Some(OAuthState {
            token_url: "https://gitlab.com/oauth/token".into(),
            client_id: "cid".into(),
            refresh_token: Some("super-secret-refresh".into()),
            expires_at: None,
        });
        let shown = format!("{c:?}");
        assert!(!shown.contains("super-secret"));
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

        let mut c = cred("kr-token");
        c.oauth = Some(OAuthState {
            token_url: "https://test.invalid/oauth/token".into(),
            client_id: "cid".into(),
            refresh_token: Some("kr-refresh".into()),
            expires_at: Some(42),
        });
        s.set(&profile, "test.invalid", &c).unwrap();
        assert_eq!(s.get(&profile, "test.invalid").unwrap(), Some(c));

        s.delete(&profile, "test.invalid").unwrap();
        assert_eq!(s.get(&profile, "test.invalid").unwrap(), None);
    }
}
